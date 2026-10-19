#!/usr/bin/env python3
"""Смена ВИДИМОГО названия приложения (внутренние ключи ether.*, ether-db, ether:// и т.п. не трогает).
Запуск: python3 tools/rebrand.py <новое_латиницей> [новое_для_ru] [новое_для_uk]
Заменяет «Ether»/«Эфир*» и локализованные имена из js/lang/*.js (app.name) в отслеживаемых текстовых файлах."""
import re, sys, subprocess, json, os
new_lat = sys.argv[1]; new_ru = sys.argv[2] if len(sys.argv) > 2 else new_lat; new_uk = sys.argv[3] if len(sys.argv) > 3 else new_ru
files = subprocess.check_output(["git", "ls-files"], text=True).split("\n")
SKIP = ("js/vendor/", "fonts/", "icons/", "sounds/", "tests/node_modules/", "package-lock.json")
TEXT = (".js", ".json", ".md", ".html", ".css", ".sh", ".webmanifest", ".yml", ".yaml", ".txt", "Dockerfile")
lat = re.compile(r"(?<![\w.\-:#@$])Ether(?![A-Za-z0-9_:\-]|\.[a-z]|//)")
ru = re.compile(r"Эфир(ом|а|у|е|ы)?(?![а-яёА-ЯЁ])")
changed = 0
# локализованные имена из словарей (app.name) → заменяем только внутри своего языка
loc = {}
for f in files:
    m = re.match(r"js/lang/([a-z]+)\.js$", f)
    if m:
        s = open(f, encoding="utf-8").read()
        mm = re.search(r'"app\.name":\s*"([^"]+)"', s)
        if mm: loc[f] = mm.group(1)
for f in files:
    if not f or f.startswith(SKIP) or not f.endswith(TEXT) or not os.path.isfile(f): continue
    if re.match(r"^[a-z]{2,3}\.(out|in)\.json$", f): continue
    try: s = open(f, encoding="utf-8").read()
    except Exception: continue
    o = s
    old = loc.get(f)
    code = f.split("/")[-1].split(".")[0]
    if old and old not in ("Ether", "Эфир"):
        target = new_uk if code == "uk" else (new_ru if code == "ru" else new_lat)
        s = s.replace(old, target)
    if f.startswith("js/lang/"): s = s.replace("Ether", new_lat if code not in ("ru","uk") else new_lat)  # словари: все формы (Etheru, Ether-guide, Etherを)
    else: s = lat.sub(new_lat, s)
    s = ru.sub(lambda m: new_ru + (m.group(1) or ""), s)
    if f == "js/app-names.json":
        d = json.loads(o)
        for k, v in d.items():
            v["name"] = new_ru if k == "ru" else (new_uk if k == "uk" else new_lat)
        s = json.dumps(d, ensure_ascii=False, indent=0)
    if s != o:
        open(f, "w", encoding="utf-8").write(s); changed += 1
print("файлов изменено:", changed)
