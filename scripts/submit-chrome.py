"""Upload the tested release ZIP and request normal Chrome Web Store review."""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


def request(url, *, body=None, token=None, content_type=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def main():
    publisher, item = (os.environ[key] for key in ("CWS_PUBLISHER_ID", "CWS_ITEM_ID"))
    if not re.fullmatch(r"[a-zA-Z0-9-]+", publisher) or not re.fullmatch(r"[a-p]{32}", item):
        sys.exit("Configure the publisher and existing dashboard item IDs before submitting.")
    auth = {key.lower(): os.environ["CWS_" + key] for key in ("CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN")}
    auth["grant_type"] = "refresh_token"
    token = request("https://oauth2.googleapis.com/token", body=urllib.parse.urlencode(auth).encode(),
                    content_type="application/x-www-form-urlencoded")["access_token"]
    root = "https://chromewebstore.googleapis.com"
    path = f"/v2/publishers/{publisher}/items/{item}"
    upload = request(root + "/upload" + path + ":upload", body=Path(sys.argv[1]).read_bytes(),
                     token=token, content_type="application/zip")
    state = upload["uploadState"]
    for _ in range(60):
        if state != "IN_PROGRESS":
            break
        time.sleep(5)
        state = request(root + path + ":fetchStatus", token=token).get("lastAsyncUploadState")
    if state != "SUCCEEDED":
        sys.exit(f"Chrome upload did not finish successfully: {state}")
    request(root + path + ":publish", body=b'{"publishType":"DEFAULT_PUBLISH","blockOnWarnings":true}',
            token=token, content_type="application/json")
    print("Submitted to Chrome Web Store. Google controls review and publication.")


if __name__ == "__main__":
    main()
