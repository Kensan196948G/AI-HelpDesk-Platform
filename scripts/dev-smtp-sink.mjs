/**
 * 検証用の最小 SMTP サーバー（外部へは送らない）。
 * 受け取ったメッセージを JSON 行として保存する。
 * 使い方: node scripts/tmp-smtp-sink.mjs <port> <outfile>
 */
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const port = Number(process.argv[2] ?? 2525);
const outfile = process.argv[3] ?? '/tmp/smtp-sink.jsonl';

const server = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  let data = '';
  let envelope = { from: '', to: [] };
  socket.write('220 sink.local ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\r\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          appendFileSync(outfile, JSON.stringify({ ...envelope, raw: data }) + '\n', 'utf8');
          data = '';
          envelope = { from: '', to: [] };
          socket.write('250 2.0.0 OK queued\r\n');
        } else {
          // ドットスタッフィング解除
          data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
        }
      } else {
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-sink.local\r\n250 PIPELINING\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          envelope.from = line.slice(line.indexOf(':') + 1).trim();
          socket.write('250 2.1.0 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          envelope.to.push(line.slice(line.indexOf(':') + 1).trim());
          socket.write('250 2.1.5 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (upper === 'RSET' || upper === 'NOOP') {
          socket.write('250 OK\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
      index = buffer.indexOf('\r\n');
    }
  });
  socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
  console.log(`smtp sink listening on 127.0.0.1:${port} -> ${outfile}`);
});
