#!/bin/bash
BRIDGE="http://127.0.0.1:11435"
KEY="${OFM_FORWARD_KEY:?请设置 OFM_FORWARD_KEY}"
m="$1"
code=$(curl -s -m 15 -o /dev/null -w "%{http_code}" "$BRIDGE/v1/chat/completions" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5,\"stream\":false}" 2>/dev/null)
echo "$code $m"
