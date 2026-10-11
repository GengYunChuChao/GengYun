// Original Demo content and structure; only disclosed accessible font/control normalization.
// Open /demo#library then an article; screenshot through the browser, never mock Mini rendering.
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const source = path.resolve(__dirname, '../../docs/ui-demo/demo.html');
const normalization = '<style>body,input,textarea,select,button,.chip,.pill,.subtitle,.hint,.card-meta,.article-card h3,.article-card>p,.prose p,.prose h3,.stat small,.btn,.text-btn,.heading-right,.page-heading p{font-size:18px!important}h1{font-size:24px!important}.btn,.back-btn,.chip{min-height:44px!important}.main{padding-bottom:100px!important}</style>';
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/demo') { res.end(fs.readFileSync(source, 'utf8').replace('</head>', normalization + '</head>')); return; }
  res.end('<!doctype html><html><body style="margin:0;background:#ddd"><iframe title="Original Demo, 320px, 18px typography" src="/demo#library" style="width:320px;height:1000px;border:0"></iframe></body></html>');
}).listen(3131, '127.0.0.1', () => console.log('Read-only original Demo on 3131; font/control normalization disclosed'));
