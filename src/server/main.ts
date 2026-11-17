import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicModel } from '../agent/model';
import { WhisperCppTranscriber } from '../analysis';
import { buildApp } from './app';
import { JobQueue } from './jobs';
import { SettingsStore } from './settings';
import { registerWebUi } from './webui';

const port = Number(process.env.VEA_PORT ?? 4317);
const app = buildApp({
  settings: new SettingsStore(),
  queue: new JobQueue(),
  model: s => new AnthropicModel({ apiKey: s.apiKey, model: s.model }),
  transcriber: s => new WhisperCppTranscriber({ binary: s.whisperBinary, modelPath: s.whisperModel }),
});

// The built UI (npm run build:web), when present.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web');
if (existsSync(path.join(webRoot, 'index.html'))) registerWebUi(app, webRoot);

// 127.0.0.1 only: the app has no login and must never be reachable from the network.
app.listen({ port, host: '127.0.0.1' }).then(
  () => console.log(`Video edit agent: http://localhost:${port}`),
  (e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
);
