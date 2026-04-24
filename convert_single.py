import sys
import json

cookie = sys.argv[1]

# TODO: gọi tool convert thật của bạn ở đây

result = {
    "email": "test@gmail.com",
    "plan": "Standard",
    "mobile": "https://netflix.com/mobile?nftoken=xxx",
    "pc": "https://netflix.com/?nftoken=xxx",
    "tv": "TV-CODE-XXXX"
}

print(json.dumps(result))