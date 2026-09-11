#!/usr/bin/env python3
"""Check bundled documentation chapters and local references without network calls."""
import pathlib
import re
root = pathlib.Path(__file__).resolve().parents[2]
summary = (root / 'docs/SUMMARY.md').read_text()
chapters = [root / 'docs' / path for path in re.findall(r'\]\(([^)]+\.md)\)', summary)]
errors = []
for chapter in chapters:
    text = re.sub(r'^```[^\n]*\n.*?^```[^\n]*$', '', chapter.read_text(), flags=re.M | re.S)
    if len(re.findall(r'^# ', text, re.M)) != 1:
        errors.append(f'{chapter.name}: expected one page heading')
    for link in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        if link.startswith(('http://', 'https://', 'mailto:', '#')):
            continue
        path = (chapter.parent / link.split('#')[0]).resolve()
        if not path.is_relative_to(root / 'docs'):
            errors.append(f'{chapter.name}: link escapes public docs: {link}')
        elif not path.is_file():
            errors.append(f'{chapter.name}: missing local link: {link}')
        elif path.suffix == '.md' and path not in chapters:
            errors.append(f'{chapter.name}: chapter omitted from manual: {link}')
for error in errors: print(error)
if errors: raise SystemExit(1)
print(f'PASS: {len(chapters)} chapters; all local links stay within shipped documentation')
