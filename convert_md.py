# save_as_md.py
import sys, json, base64, pathlib

data = (
    json.load(sys.stdin)
    if sys.stdin.isatty() is False
    else json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
)
b64 = data["file_content_64"]
fname = data.get("filename", "output.md")

path = pathlib.Path(fname)
path.parent.mkdir(parents=True, exist_ok=True)
content = base64.b64decode(b64).decode("utf-8", errors="replace")
path.write_text(content, encoding="utf-8")

print(f"Saved: {path.resolve()}")
