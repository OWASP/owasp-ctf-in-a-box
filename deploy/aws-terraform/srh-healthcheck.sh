wget -q -T 4 -O - --header="Authorization: Bearer $SRH_TOKEN" --header="Content-Type: application/json" --post-data='["PING"]' http://127.0.0.1:80/ | grep -q PONG || exit 1
