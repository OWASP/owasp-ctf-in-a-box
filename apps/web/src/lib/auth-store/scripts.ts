// Compare-and-set writers for the Redis user store. Each script applies only
// if the stored row is byte-identical to the snapshot the caller read, so two
// writers that read the same row cannot both win, and the row and its index
// sets change in one atomic step. They never re-encode a row: `newJson` is
// stored verbatim, so nothing depends on cjson key ordering.
//
// Index keys are `<prefix>:<model>:by:<field>:<value>` and must stay
// byte-identical to `indexKey` in ./keys.ts. Only string, number and boolean
// fields are indexed; null, absent and nested values are left out.

const INDEX_HELPERS = `
local function index_key(prefix, model, field, value)
  return prefix .. ":" .. model .. ":by:" .. field .. ":" .. value
end

local function indexable(v)
  local t = type(v)
  return t == "string" or t == "number" or t == "boolean"
end

local function each_field(csv)
  return string.gmatch(csv, "[^,]+")
end

local function unindex(prefix, model, id, row, csv)
  for field in each_field(csv) do
    local v = row[field]
    if indexable(v) then
      redis.call("SREM", index_key(prefix, model, field, tostring(v)), id)
    end
  end
end
`;

// KEYS[1] rows hash
// ARGV: prefix, model, id, expectedJson ("" = must not exist), newJson, indexedFieldsCsv
// Returns 1 written, 0 snapshot mismatch.
export const PUT_ROW_SCRIPT = `${INDEX_HELPERS}
local prefix, model, id = ARGV[1], ARGV[2], ARGV[3]
local expected, newJson, csv = ARGV[4], ARGV[5], ARGV[6]

local current = redis.call("HGET", KEYS[1], id)
if expected == "" then
  if current then return 0 end
else
  if current ~= expected then return 0 end
  unindex(prefix, model, id, cjson.decode(current), csv)
end

redis.call("HSET", KEYS[1], id, newJson)
local row = cjson.decode(newJson)
for field in each_field(csv) do
  local v = row[field]
  if indexable(v) then
    redis.call("SADD", index_key(prefix, model, field, tostring(v)), id)
  end
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

unindex(prefix, model, id, cjson.decode(current), csv)
redis.call("HDEL", KEYS[1], id)
return 1
`;
