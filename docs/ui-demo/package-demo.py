from pathlib import Path
import base64

root = Path(__file__).resolve().parent
dist = root / 'dist'
html = (dist / 'index.html').read_text(encoding='utf-8')
css = (dist / 'styles.css').read_text(encoding='utf-8')
js = (dist / 'app.js').read_text(encoding='utf-8')
asset = 'data:image/svg+xml;base64,' + base64.b64encode((dist / 'assets/field.svg').read_bytes()).decode('ascii')
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
html = html.replace('<script src="app.js"></script>', '<script>' + js.replace('assets/field.svg', asset) + '</script>')
(root / 'demo.html').write_text(html, encoding='utf-8')
print('Standalone demo.html saved')
