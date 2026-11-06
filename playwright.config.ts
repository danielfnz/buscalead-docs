import { defineConfig, devices } from '@playwright/test';

// Servidor local: python3 http.server (não aplica o try_files do nginx: os testes usam URLs .html;
// o try_files é validado pelo tests/docker-nginx.sh). PW_BASE_URL aponta a suíte para outro servidor
// (ex.: o container nginx) e desliga o servidor local.
const PORT = Number(process.env.PW_PORT || 4310);
const externalBase = process.env.PW_BASE_URL;

export default defineConfig({
    testDir: './tests',
    testMatch: /.*\.spec\.ts/,
    outputDir: './test-results/pw',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 45_000,
    reporter: 'list',
    use: {
        baseURL: externalBase || `http://127.0.0.1:${PORT}`,
        // Os browsers do Playwright não estão no cache desta máquina: Chrome do sistema.
        // Sem PW_CHROME_PATH usa o browser que o Playwright instalou.
        launchOptions: process.env.PW_CHROME_PATH ? { executablePath: process.env.PW_CHROME_PATH } : {},
        ...devices['Desktop Chrome'],
    },
    webServer: externalBase
        ? undefined
        : {
              command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory .`,
              url: `http://127.0.0.1:${PORT}/index.html`,
              reuseExistingServer: false,
              timeout: 15_000,
              stdout: 'ignore',
              stderr: 'ignore',
          },
});
