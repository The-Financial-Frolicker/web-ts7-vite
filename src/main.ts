import './style.css'
import heroImg from './assets/hero.png'
import typescriptLogo from './assets/typescript.svg'
import viteLogo from './assets/vite.svg'
import { setupCounter } from './counter.ts'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<section id="center">
  <div class="hero">
    <img src="${heroImg}" class="base" width="170" height="179">
    <img src="${typescriptLogo}" class="framework" alt="TypeScript logo"/>
    <img src="${viteLogo}" class="vite" alt="Vite logo" />
  </div>
  <div>
    <h1>Get started</h1>
    <p>Edit <code>src/main.ts</code> and save to test <code>HMR</code></p>
  </div>
  <button id="counter" type="button" class="counter"></button>
</section>

<div class="ticks"></div>

<section id="next-steps">
  <div id="docs">
    <svg class="icon" role="presentation" aria-hidden="true"><use href="/icons.svg#documentation-icon"></use></svg>
    <h2>Documentation</h2>
    <p>Your questions, answered</p>
    <ul>
      <li>
        <a href="https://vite.dev/" target="_blank">
          <img class="logo" src="${viteLogo}" alt="" />
          Explore Vite
        </a>
      </li>
      <li>
        <a href="https://www.typescriptlang.org" target="_blank">
          <img class="button-icon" src="${typescriptLogo}" alt="">
          Learn more
        </a>
      </li>
    </ul>
  </div>
  <div id="social">
    <svg class="icon" role="presentation" aria-hidden="true"><use href="/icons.svg#social-icon"></use></svg>
    <h2>Connect with us</h2>
    <p>Join the Vite community</p>
    <ul>
      <li><a href="https://github.com/vitejs/vite" target="_blank"><svg class="button-icon" role="presentation" aria-hidden="true"><use href="/icons.svg#github-icon"></use></svg>GitHub</a></li>
      <li><a href="https://chat.vite.dev/" target="_blank"><svg class="button-icon" role="presentation" aria-hidden="true"><use href="/icons.svg#discord-icon"></use></svg>Discord</a></li>
      <li><a href="https://x.com/vite_js" target="_blank"><svg class="button-icon" role="presentation" aria-hidden="true"><use href="/icons.svg#x-icon"></use></svg>X.com</a></li>
      <li><a href="https://bsky.app/profile/vite.dev" target="_blank"><svg class="button-icon" role="presentation" aria-hidden="true"><use href="/icons.svg#bluesky-icon"></use></svg>Bluesky</a></li>
    </ul>
  </div>
</section>

<div class="ticks"></div>
<section id="spacer"></section>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)
type WasmMathModule = {
    _add(a: number, b: number): number;
};

type WasmMathFactory = () => Promise<WasmMathModule>;

const wasmOutput = document.createElement('p');
wasmOutput.id = 'wasm-result';
wasmOutput.textContent = 'Loading WebAssembly...';

document.querySelector('#app')?.append(wasmOutput);

async function initialiseWasm(): Promise<void> {
    try {
        const moduleUrl = new URL(
            '/wasm/wasm_math.js',
            window.location.href
        );

        const wasmModule = await import(
            /* @vite-ignore */ moduleUrl.href
        ) as { default: WasmMathFactory };

        const wasm = await wasmModule.default();

        const result = wasm._add(19, 23);

        wasmOutput.textContent = `WebAssembly result: 19 + 23 = ${result}`;
    } catch (error) {
        wasmOutput.textContent = 'WebAssembly initialisation failed.';
        console.error('WASM initialisation error:', error);
    }
}

void initialiseWasm();

type WorkerHealth = {
    status: string;
    service: string;
    runtime: string;
    timestamp: string;
};

const workerOutput = document.createElement('p');
workerOutput.id = 'worker-health';
workerOutput.textContent = 'Checking Cloudflare Worker...';
document.querySelector('#app')?.append(workerOutput);

async function checkWorker(): Promise<void> {
    try {
        const response = await fetch('/api/health');

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const health = await response.json() as WorkerHealth;

        workerOutput.textContent =
            `Worker: ${health.status} | ${health.runtime} | ${health.timestamp}`;
    } catch (error) {
        workerOutput.textContent = 'Cloudflare Worker request failed.';
        console.error('Worker health check:', error);
    }
}

void checkWorker();