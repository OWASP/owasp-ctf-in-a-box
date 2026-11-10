// Compare-and-set writers for the Redis user store. Each script applies only
// if the stored row is byte-identical to the snapshot the caller read, so two
// writers that read the same row cannot both win, and the row and its index
// sets change in one atomic step. They never re-encode a row: `newJson` is
// stored verbatim, so nothing depends on cjson key ordering.
//
// Index keys are `<prefix>:<model>:by:<field>:<value>` and must stay
// byte-identical to `indexKey` in ./keys.ts. Only string, number and boolean
// fields are indexed; null, absent and nested values are left out. A field
// name joining parts with "+" indexes the parts joined with ":", and only when
// every part is indexable.
//
// The scripts build index keys inside Lua, so they are not declared in KEYS:
// fine on the single Redis behind srh or Upstash, not safe on Redis Cluster.

const INDEX_HELPERS = `
local function index_key(prefix, model, field, value)
  return prefix .. ":" .. model .. ":by:" .. field .. ":" .. value
end

local function indexable(v)
  local t = type(v)
  return t == "string" or t == "number" or t == "boolean"
end

local function decode_object(json, what)
  local ok, row = pcall(cjson.decode, json)
  if not ok or type(row) ~= "table" then
    return nil, "auth store: " .. what .. " is not a JSON object"
  end
  return row, nil
end

local function each_field(csv)
  return string.gmatch(csv, "[^,]+")
end

local function field_value(row, field)
  if not string.find(field, "+", 1, true) then
    local v = row[field]
    if indexable(v) then return tostring(v) end
    return nil
  end
  local parts = {}
  for part in string.gmatch(field, "[^+]+") do
    local v = row[part]
    if not indexable(v) then return nil end
    parts[#parts + 1] = tostring(v)
  end
  return table.concat(parts, ":")
end

local function unindex(prefix, model, id, row, csv)
  for field in each_field(csv) do
    local v = field_value(row, field)
    if v then redis.call("SREM", index_key(prefix, model, field, v), id) end
  end
end
`;

// KEYS[1] rows hash
// ARGV: prefix, model, id, expectedJson ("" = must not exist), newJson,
//       indexedFieldsCsv, uniqueFieldsCsv (each also in indexedFieldsCsv)
// Returns 1 written, 0 snapshot mismatch, 2 a unique field's value is held by
// another row that still exists. On 0 and 2 nothing is written.
export const PUT_ROW_SCRIPT = `${INDEX_HELPERS}
local prefix, model, id = ARGV[1], ARGV[2], ARGV[3]
local expected, newJson, csv = ARGV[4], ARGV[5], ARGV[6]
local unique = ARGV[7] or ""

local row, rowErr = decode_object(newJson, "newJson")
if not row then return redis.error_reply(rowErr) end

local current = redis.call("HGET", KEYS[1], id)
local old
if expected == "" then
  if current then return 0 end
else
  if current ~= expected then return 0 end
  local oldErr
  old, oldErr = decode_object(current, "stored row")
  if not old then return redis.error_reply(oldErr) end
end

-- An index member whose row is gone is a stale entry, not an owner.
for field in each_field(unique) do
  local v = field_value(row, field)
  if v then
    for _, other in ipairs(redis.call("SMEMBERS", index_key(prefix, model, field, v))) do
      if other ~= id and redis.call("HEXISTS", KEYS[1], other) == 1 then return 2 end
    end
  end
end

if old then unindex(prefix, model, id, old, csv) end
redis.call("HSET", KEYS[1], id, newJson)
for field in each_field(csv) do
  local v = field_value(row, field)
  if v then redis.call("SADD", index_key(prefix, model, field, v), id) end
end
return 1
`;

// KEYS[1] rows hash
// ARGV: prefix, model, id, expectedJson, indexedFieldsCsv
// Returns 1 deleted, 0 snapshot mismatch (including a missing row).
export const DEL_ROW_SCRIPT = `${INDEX_HELPERS}
local prefix, model, id = ARGV[1], ARGV[2], ARGV[3]
local expected, csv = ARGV[4], ARGV[5]

local current = redis.call("HGET", KEYS[1], id)
if current ~= expected then return 0 end

local old, oldErr = decode_object(current, "stored row")
if not old then return redis.error_reply(oldErr) end
unindex(prefix, model, id, old, csv)
redis.call("HDEL", KEYS[1], id)
return 1
`;
