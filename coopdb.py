#!/usr/bin/env python3
"""Co-op 投递台数据库命令行（任何 AI 都能用，只需要 Python 3，不用装包）。Claude 2026-11-26

钥匙：环境变量 COOP_KEY，或文件 ~/.config/coop-board/key（在网页底部“AI 接入与调试”里生成）。
每次写入都要用 --who 写明自己是谁（claude / codex / gemini / muse），会记进改动日志。

  python3 coopdb.py collections                       # 各集合有多少条
  python3 coopdb.py list jobs [--ids]                 # 整个集合（JSON）
  python3 coopdb.py get jobs ec-112661                # 一条
  python3 coopdb.py update jobs ec-112661 '{"status":"applied"}' --who codex [--if-version 3]
  python3 coopdb.py set meta profile @profile.json --who claude
  python3 coopdb.py delete requests abc123 --who claude --if-version 2
  python3 coopdb.py batch writes.json --who claude    # [{op,collection,doc_id,data,if_version}]，最多 200 条，全成或全不成
  python3 coopdb.py export ./backup                   # 每个集合存成 <dir>/<collection>/<doc_id>.json
"""
import json, os, sys, urllib.request, urllib.error, pathlib

URL = "https://snrlbgksmydgtwwasdgk.supabase.co/rest/v1/rpc/"
ANON = "sb_publishable_gfZJQR2lreNoQd_gl2DHFQ_IgcNf9o4"   # 公开的 publishable key；真正的权限在钥匙上
COLLECTIONS = ["jobs", "resumes", "meta", "questions", "requests", "letters", "analysis"]


def key():
    k = os.environ.get("COOP_KEY")
    if not k:
        p = pathlib.Path.home() / ".config/coop-board/key"
        if p.exists():
            k = p.read_text().strip()
    if not k:
        sys.exit("没有钥匙：设置 COOP_KEY，或把钥匙存到 ~/.config/coop-board/key（网页底部“AI 接入与调试”里生成）")
    return k


def rpc(fn, body):
    req = urllib.request.Request(URL + fn, data=json.dumps(body).encode(), method="POST",
                                 headers={"apikey": ANON, "Authorization": "Bearer " + ANON, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"出错 {e.code}: {e.read().decode(errors='replace')}")


def load_data(arg):
    if arg.startswith("@"):
        return json.loads(pathlib.Path(arg[1:]).read_text(encoding="utf-8"))
    return json.loads(arg)


def opt(args, name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default


def main(a):
    if not a or a[0] in ("-h", "--help"):
        print(__doc__); return
    who = opt(a, "--who", None)
    ifv = opt(a, "--if-version", None)
    cmd = a[0]
    if cmd == "collections":
        out = rpc("coop_ai_read", {"p_key": key()})
    elif cmd == "list":
        out = rpc("coop_ai_read", {"p_key": key(), "p_collection": a[1]})
        if "--ids" in a:
            out = [{"doc_id": d["doc_id"], "version": d["version"], "updated_by": d["updated_by"]} for d in out]
    elif cmd == "get":
        r = rpc("coop_ai_read", {"p_key": key(), "p_collection": a[1], "p_doc_id": a[2]})
        out = r[0] if r else None
    elif cmd in ("set", "update", "delete", "batch"):
        if not who:
            sys.exit("写入要加 --who <你是谁>，例如 --who codex")
        if cmd == "batch":
            writes = load_data("@" + a[1] if not a[1].startswith(("@", "[")) else a[1])
        else:
            w = {"op": cmd, "collection": a[1], "doc_id": a[2]}
            if cmd != "delete":
                w["data"] = load_data(a[3])
            if ifv:
                w["if_version"] = int(ifv)
            writes = [w]
        out = rpc("coop_ai_write", {"p_key": key(), "p_writes": writes, "p_who": who})
    elif cmd == "export":
        d = pathlib.Path(a[1]); n = 0
        for c in COLLECTIONS:
            for doc in rpc("coop_ai_read", {"p_key": key(), "p_collection": c}):
                p = d / c / (doc["doc_id"] + ".json"); p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8"); n += 1
        out = {"exported": n, "dir": str(d)}
    else:
        sys.exit("不认识的命令：" + cmd + "（用 -h 看用法）")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
