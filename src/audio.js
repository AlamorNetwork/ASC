import { spawn } from 'node:child_process';

/** Telegram sends OGG/Opus; some OpenAI-compatible Gemini gateways only accept MP3. */
export function oggToMp3(buffer, { timeoutMs = 60000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'ogg', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1',
    ];
    let child;
    try { child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (err) { reject(err); return; }

    const chunks = [];
    let bytes = 0;
    let errors = '';
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('تبدیل ویس به MP3 بیش از حد طول کشید'));
    }, timeoutMs);

    child.on('error', (err) => finish(new Error(
      err.code === 'ENOENT' ? 'ffmpeg نصب نیست؛ روی سرور apt-get install ffmpeg بزن' : err.message)));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        finish(new Error('ویس تبدیل‌شده از حد مجاز بزرگ‌تر شد'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-500); });
    child.on('close', (code) => {
      if (code !== 0 || !bytes) finish(new Error(`تبدیل ویس انجام نشد: ${errors.trim() || `ffmpeg exit ${code}`}`));
      else finish(null, Buffer.concat(chunks, bytes));
    });
    child.stdin.on('error', () => {}); // a failed conversion can close stdin early
    child.stdin.end(buffer);
  });
}
