/**
 * Portal docs.buscalead.com (Plano D). Roda contra o site estático servido por python http.server
 * (URLs .html) ou, com PW_BASE_URL, contra o container nginx (tests/docker-nginx.sh).
 *
 * Autoridade dos números: spec §6.2 (planos), §6.5 (402), §6.7 (portal). Os exemplos da doc saem do
 * código do Plano A (query.ts, empresa-dto.ts, errors.ts): as listas abaixo copiam esses arquivos.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'test-results');
const WIDTHS = [375, 768, 1440] as const;
const WHATSAPP = '5534992885263'; // número oficial: buscalead-front footer / billing-settings / auth
const PAINEL = 'https://buscalead.com/api/painel';
const REGISTER = 'https://buscalead.com/auth/register?returnUrl=%2Fapi%2Fpainel';

// Spec §6.2 com os `code` do seed api_plans (create-api-v2-accounts.sql). `price` é a string do JSON-LD.
const SPEC_PLANS = [
    { code: 'basico_1', name: 'Básico 1', price: '29.90', brl: '29,90', credits: 5000, creditsTxt: '5.000', unit: '0,006' },
    { code: 'basico_2', name: 'Básico 2', price: '59.90', brl: '59,90', credits: 12000, creditsTxt: '12.000', unit: '0,005' },
    { code: 'basico_3', name: 'Básico 3', price: '99.90', brl: '99,90', credits: 25000, creditsTxt: '25.000', unit: '0,004' },
    { code: 'intermediario_1', name: 'Intermediário 1', price: '199.90', brl: '199,90', credits: 70000, creditsTxt: '70.000', unit: '0,0029' },
    { code: 'intermediario_2', name: 'Intermediário 2', price: '499.90', brl: '499,90', credits: 250000, creditsTxt: '250.000', unit: '0,002' },
    { code: 'intermediario_3', name: 'Intermediário 3', price: '749.90', brl: '749,90', credits: 500000, creditsTxt: '500.000', unit: '0,0015' },
    { code: 'avancado_1', name: 'Avançado 1', price: '999.90', brl: '999,90', credits: 1000000, creditsTxt: '1.000.000', unit: '0,001' },
    { code: 'avancado_2', name: 'Avançado 2', price: '1999.90', brl: '1.999,90', credits: 3000000, creditsTxt: '3.000.000', unit: '0,00067' },
];

const CATALOG = {
    plans: SPEC_PLANS.map((p) => ({ code: p.code, name: p.name, month_price: Number(p.price), monthly_credits: p.credits })),
    topup: { min_credits: 1000, max_credits: 100000, price_per_credit: 0.01 },
};

// ─── helpers ────────────────────────────────────────────────────────────────

/** Erros que devem ser zero: console.error, exceção na página, request que falhou, resposta >= 400. */
function watch(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    return problems;
}

async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
}

async function expectNoHScroll(page: Page): Promise<void> {
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(sw, `rolagem horizontal: scrollWidth ${sw} > innerWidth ${iw}`).toBeLessThanOrEqual(iw);
}

async function shot(page: Page, name: string, width: number): Promise<void> {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(900); // animações de entrada (CSS) terminam em < 900 ms
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true });
}

/** Texto visível sem espaços repetidos (nbsp incluso). */
async function visibleText(page: Page): Promise<string> {
    return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

/** Liga ou desliga SALES_OPEN reescrevendo a constante do site.js servido (o arquivo real não muda). */
async function setSales(page: Page, open: boolean): Promise<void> {
    await page.route('**/assets/site.js*', async (route) => {
        const res = await route.fetch();
        const body = (await res.text()).replace(/const SALES_OPEN = (true|false);/, `const SALES_OPEN = ${open};`);
        await route.fulfill({ response: res, body });
    });
}

// Padrão determinístico: vendas fechadas (sem chamada real à api.buscalead.com). Os testes de vendas abertas
// chamam setSales(page, true) depois, e a rota registrada por último vence.
test.beforeEach(async ({ page }) => {
    await setSales(page, false);
});

type Call = { method: string; path: string; body: Record<string, unknown> | null };

/** Backend de checkout falso (Plano B): grava as chamadas e responde com o contrato do Plano B. */
async function mockApi(page: Page, opts: { catalog?: unknown; expireFirstPayment?: boolean } = {}): Promise<Call[]> {
    const calls: Call[] = [];
    const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    let expire = !!opts.expireFirstPayment;
    await page.route('https://api.buscalead.com/**', async (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const url = new URL(req.url());
        const raw = req.postData();
        calls.push({ method: req.method(), path: url.pathname, body: raw ? JSON.parse(raw) : null });
        switch (url.pathname) {
            case '/v1/public-checkout/api-plans':
                return route.fulfill({ status: 200, headers: cors, json: opts.catalog ?? CATALOG });
            case '/v1/public-checkout/start':
                return route.fulfill({ status: 200, headers: cors, json: { token: `tok_${calls.length}`, product: 'api' } });
            case '/v1/public-checkout/api-subscription':
            case '/v1/public-checkout/api-topup':
                if (expire) {
                    expire = false;
                    return route.fulfill({ status: 401, headers: cors, json: { title: 'Sessão expirada', message: 'Reinicie o checkout.', code: 401 } });
                }
                return route.fulfill({ status: 200, headers: cors, json: { payment_url: `https://pay.example.test/checkout/${url.pathname.split('/').pop()}` } });
            default:
                return route.fulfill({ status: 404, headers: cors, json: { title: 'Not found', message: url.pathname, code: 404 } });
        }
    });
    await page.route('https://pay.example.test/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Pagamento (mock)</h1>' }));
    return calls;
}

/** Todos os href="#x" da página apontam para um id existente. */
async function brokenAnchors(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
            .map((a) => a.getAttribute('href') as string)
            .filter((h) => h.length > 1 && !document.getElementById(decodeURIComponent(h.slice(1)))));
}

// Copy proibida (CLAUDE.md, PRODUCT.md, spec §1 e §10): concorrente, complexidade, frescor da base.
const FORBIDDEN_COPY = [
    /casa dos dados|econodata|driva|speedio|meetime|ramper/i,
    /sem (telas )?complica|chega de |descomplic|\bf[aá]cil\b|facilmente|sem burocracia/i,
    /atualizad[oa]s? (diariamente|mensalmente|semanalmente|todo|toda|sempre)|atualiza[cç][aã]o (di[aá]ria|mensal|semanal)|tempo real/i,
    /n[aã]o (traz|tem|possui|entrega) (telefone|e-mail|contato)/i,
];

// ═════════════════════════════════════════════════════════════════════════════
// Task 1 — página do produto (index.html)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('produto (index.html)', () => {
    test('hero tem "Começar grátis" e o curl da busca v2', async ({ page }) => {
        await page.goto('/index.html');
        await expect(page.locator('h1')).toContainText('telefone e e-mail');
        await expect(page.locator('#hero').getByRole('link', { name: /Começar grátis/ })).toBeVisible();
        const code = page.locator('#hero pre').first();
        await expect(code).toContainText('curl');
        await expect(code).toContainText("curl -G 'https://api.buscalead.com/v2/empresas'");
        await expect(code).toContainText('-d cnae=8630504');
        await expect(code).toContainText('Authorization: Bearer');
    });

    test('8 cards de plano com os preços exatos e o avulso', async ({ page }) => {
        await page.goto('/index.html');
        const cards = page.locator('#planos .plan[data-plan]:not([data-plan="avulso"])');
        await expect(cards).toHaveCount(8);
        for (const p of SPEC_PLANS) {
            const card = page.locator(`#planos .plan[data-plan="${p.code}"]`);
            await expect(card, p.code).toHaveCount(1);
            await expect(card.locator('[data-price]')).toHaveAttribute('data-price', p.price);
            await expect(card).toContainText(`R$ ${p.brl}`);
            await expect(card).toContainText(`${p.creditsTxt} consultas`);
            await expect(card).toContainText(`R$ ${p.unit} por consulta`);
            await expect(card).toContainText(p.name);
        }
        const avulso = page.locator('#planos .plan[data-plan="avulso"]');
        await expect(avulso).toContainText('R$ 0,01');
        await expect(avulso).toContainText('R$ 10,00');
        await expect(avulso).toContainText('R$ 1.000,00');
        await expect(avulso).toContainText(/cartão ou PIX/);
        const section = page.locator('#planos');
        await expect(section).toContainText('200 consultas');
        await expect(section).toContainText('7 dias');
        await expect(section).toContainText(/assinatura.*cartão de crédito/i);
    });

    test('um único array de planos (window.BUSCALEAD_API_PLANS) alimenta os cards', async ({ page }) => {
        await page.goto('/index.html');
        const plans = await page.evaluate(() => (window as unknown as { BUSCALEAD_API_PLANS: unknown }).BUSCALEAD_API_PLANS);
        expect(plans).toEqual(SPEC_PLANS.map((p) => ({ code: p.code, name: p.name, price: Number(p.price), credits: p.credits })));
        const rendered = await page.locator('#planos .plan[data-plan]:not([data-plan="avulso"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-plan')));
        expect(rendered).toEqual(SPEC_PLANS.map((p) => p.code));
    });

    test('FAQ existe e abre', async ({ page }) => {
        await page.goto('/index.html');
        const items = page.locator('#faq details');
        expect(await items.count()).toBeGreaterThanOrEqual(8);
        const first = items.first();
        await first.locator('summary').click();
        await expect(first).toHaveAttribute('open', '');
        await expect(page.locator('#faq')).toContainText(/teste grátis/i);
        await expect(page.locator('#faq')).toContainText(/sem resultado|vazia/i);
    });

    test('JSON-LD tem 8 Offer com os preços exatos', async ({ page }) => {
        await page.goto('/index.html');
        const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
        expect(blocks.length).toBeGreaterThan(0);
        const offers: Array<{ name: string; price: string; priceCurrency: string }> = [];
        const walk = (n: unknown): void => {
            if (Array.isArray(n)) return n.forEach(walk);
            if (n && typeof n === 'object') {
                const o = n as Record<string, unknown>;
                if (o['@type'] === 'Offer') offers.push(o as never);
                Object.values(o).forEach(walk);
            }
        };
        blocks.forEach((b) => walk(JSON.parse(b)));
        expect(offers).toHaveLength(8);
        expect(offers.map((o) => [o.name, o.price, o.priceCurrency])).toEqual(SPEC_PLANS.map((p) => [p.name, p.price, 'BRL']));
        const app = JSON.parse(blocks[0]);
        expect(app['@type']).toBe('SoftwareApplication');
    });

    test('SEO: title, description, canonical e Open Graph', async ({ page }) => {
        await page.goto('/index.html');
        await expect(page).toHaveTitle(/API de CNPJ.*BuscaLead/);
        const meta = (sel: string) => page.locator(sel).getAttribute('content');
        expect((await meta('meta[name="description"]'))!.length).toBeGreaterThan(80);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://docs.buscalead.com/');
        for (const p of ['og:title', 'og:description', 'og:type', 'og:url', 'og:image']) {
            expect(await meta(`meta[property="${p}"]`), p).toBeTruthy();
        }
        const ogImage = (await meta('meta[property="og:image"]'))!.replace('https://docs.buscalead.com', '');
        expect((await page.request.get(ogImage)).status()).toBe(200);
    });

    test('0 erros de console, sem concorrente, sem complexidade, sem promessa de atualização', async ({ page }) => {
        const problems = watch(page);
        await page.goto('/index.html');
        await settle(page);
        const text = await visibleText(page);
        for (const re of FORBIDDEN_COPY) expect(text, String(re)).not.toMatch(re);
        expect(problems).toEqual([]);
    });

    for (const width of WIDTHS) {
        test(`render em ${width}px sem rolagem horizontal`, async ({ page }) => {
            const problems = watch(page);
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/index.html');
            await settle(page);
            await expectNoHScroll(page);
            await expect(page.locator('#planos .plan[data-plan]')).toHaveCount(9);
            await shot(page, 'index', width);
            expect(problems).toEqual([]);
        });
    }

    test('âncoras da página resolvem e o explorador de resposta destaca o grupo', async ({ page }) => {
        await page.goto('/index.html');
        expect(await brokenAnchors(page)).toEqual([]);
        const viewer = page.locator('#resposta [data-explorer]');
        await expect(viewer).toHaveAttribute('data-focus', 'contato');
        await page.locator('#resposta button[data-group="socios"]').click();
        await expect(viewer).toHaveAttribute('data-focus', 'socios');
        await expect(page.locator('#resposta button[data-group="socios"]')).toHaveAttribute('aria-pressed', 'true');
    });

    test('SALES_OPEN vem ligado no arquivo (lançamento 2026-11-06) e o HTML versiona o site.js', async () => {
        const js = fs.readFileSync(path.join(ROOT, 'assets', 'site.js'), 'utf8');
        expect(js).toContain('const SALES_OPEN = true;');
        for (const page of ['index.html', 'docs.html', 'contratacao/sucesso.html']) {
            const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
            expect(html, page).toMatch(/src="\/assets\/site\.js\?v=\d{8}"/);
        }
    });

    test('SALES_OPEN=false: nenhuma requisição à api.buscalead.com; "Assinar" e "Começar grátis" abrem o "Fale com a gente"', async ({ page }) => {
        const toApi: string[] = [];
        page.on('request', (r) => { if (r.url().includes('api.buscalead.com')) toApi.push(r.url()); });
        await page.goto('/index.html');
        await settle(page);

        const card = page.locator('#planos .plan[data-plan="basico_2"]');
        await expect(card.locator('.soon')).toHaveText(/em breve/i);
        await card.getByRole('link', { name: /Assinar/ }).click();
        const dlg = page.getByRole('dialog', { name: 'Fale com a gente' });
        await expect(dlg).toBeVisible();
        const wa = dlg.getByRole('link', { name: /WhatsApp/ });
        await expect(wa).toHaveAttribute('href', new RegExp(`^https://wa\\.me/${WHATSAPP}\\?text=.*B%C3%A1sico%202`));
        await page.keyboard.press('Escape');
        await expect(dlg).toBeHidden();

        await page.locator('#hero').getByRole('link', { name: /Começar grátis/ }).click();
        await expect(dlg).toBeVisible();
        await page.keyboard.press('Escape');

        await page.locator('#planos .plan[data-plan="avulso"]').getByRole('link', { name: /Comprar avulso/ }).click();
        await expect(dlg).toBeVisible();

        expect(toApi).toEqual([]);
    });

    test('SALES_OPEN=true: "Começar grátis" vai ao cadastro com returnUrl e a página confere o catálogo', async ({ page }) => {
        await setSales(page, true);
        const calls = await mockApi(page);
        await page.goto('/index.html');
        await settle(page);
        await expect(page.locator('#hero').getByRole('link', { name: /Começar grátis/ })).toHaveAttribute('href', REGISTER);
        await expect(page.locator('.soon')).toHaveCount(0);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/public-checkout/api-plans']);
    });

    test('SALES_OPEN=true: assinatura segue start → api-subscription e redireciona ao payment_url', async ({ page }) => {
        await setSales(page, true);
        const calls = await mockApi(page);
        await page.goto('/index.html');
        await page.locator('#planos .plan[data-plan="basico_2"]').getByRole('link', { name: /Assinar/ }).click();
        const dlg = page.getByRole('dialog', { name: /Assinar Básico 2/ });
        await expect(dlg).toContainText('R$ 59,90');

        // validação local: e-mail inválido não chama a API
        await dlg.getByLabel('Nome').fill('Maria Teste');
        await dlg.getByLabel('E-mail').fill('maria-sem-arroba');
        await dlg.getByRole('button', { name: /Ir para o pagamento/ }).click();
        await expect(dlg.getByRole('alert')).toContainText(/e-mail/i);
        expect(calls.filter((c) => c.path.includes('/start'))).toHaveLength(0);

        await dlg.getByLabel('E-mail').fill('maria@exemplo.com');
        await dlg.getByLabel(/WhatsApp/).fill('11987654321');
        await dlg.getByLabel(/Empresa/).fill('Exemplo Ltda');
        await dlg.getByRole('button', { name: /Ir para o pagamento/ }).click();
        await page.waitForURL('https://pay.example.test/checkout/api-subscription');

        const flow = calls.filter((c) => c.method === 'POST');
        expect(flow.map((c) => c.path)).toEqual(['/v1/public-checkout/start', '/v1/public-checkout/api-subscription']);
        expect(flow[0].body).toEqual({ product: 'api', email: 'maria@exemplo.com', nome: 'Maria Teste', whatsapp: '11987654321', companyName: 'Exemplo Ltda' });
        expect(flow[1].body).toEqual({ token: 'tok_2', plan_code: 'basico_2' });
    });

    test('SALES_OPEN=true: avulso valida o intervalo e segue start → api-topup', async ({ page }) => {
        await setSales(page, true);
        const calls = await mockApi(page);
        await page.goto('/index.html');
        await page.locator('#planos .plan[data-plan="avulso"]').getByRole('link', { name: /Comprar avulso/ }).click();
        const dlg = page.getByRole('dialog', { name: /Comprar créditos avulsos/ });
        await dlg.getByLabel('Nome').fill('João Teste');
        await dlg.getByLabel('E-mail').fill('joao@exemplo.com');

        const credits = dlg.getByLabel(/Quantidade de créditos/);
        await credits.fill('500');
        await dlg.getByRole('button', { name: /Ir para o pagamento/ }).click();
        await expect(dlg.getByRole('alert')).toContainText(/1\.000.*100\.000/);
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

        await credits.fill('5000');
        await expect(dlg).toContainText('R$ 50,00');
        await dlg.getByRole('button', { name: /Ir para o pagamento/ }).click();
        await page.waitForURL('https://pay.example.test/checkout/api-topup');
        const flow = calls.filter((c) => c.method === 'POST');
        expect(flow.map((c) => c.path)).toEqual(['/v1/public-checkout/start', '/v1/public-checkout/api-topup']);
        expect(flow[0].body).toEqual({ product: 'api', email: 'joao@exemplo.com', nome: 'João Teste' });
        expect(flow[1].body).toEqual({ token: 'tok_2', credits: 5000 });
    });

    test('SALES_OPEN=true: token expirado (401) reinicia o fluxo uma vez', async ({ page }) => {
        await setSales(page, true);
        const calls = await mockApi(page, { expireFirstPayment: true });
        await page.goto('/index.html');
        await page.locator('#planos .plan[data-plan="basico_1"]').getByRole('link', { name: /Assinar/ }).click();
        const dlg = page.getByRole('dialog', { name: /Assinar Básico 1/ });
        await dlg.getByLabel('Nome').fill('Ana Teste');
        await dlg.getByLabel('E-mail').fill('ana@exemplo.com');
        await dlg.getByRole('button', { name: /Ir para o pagamento/ }).click();
        await page.waitForURL('https://pay.example.test/checkout/api-subscription');
        expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
            '/v1/public-checkout/start', '/v1/public-checkout/api-subscription',
            '/v1/public-checkout/start', '/v1/public-checkout/api-subscription',
        ]);
    });

    test('SALES_OPEN=true: catálogo divergente vira console.warn e não quebra a página', async ({ page }) => {
        await setSales(page, true);
        const warns: string[] = [];
        page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
        const bad = structuredClone(CATALOG);
        bad.plans[0].month_price = 39.9;
        await mockApi(page, { catalog: bad });
        await page.goto('/index.html');
        await settle(page);
        await expect(page.locator('#planos .plan[data-plan]')).toHaveCount(9);
        expect(warns.some((w) => w.includes('basico_1') && w.includes('catálogo'))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Task 2 — documentação (docs.html)
// ═════════════════════════════════════════════════════════════════════════════

// query.ts → KNOWN_PARAMETERS (qualquer outro nome = 400 invalid_parameter)
const KNOWN_PARAMS = ['cnae', 'incluir_cnae_secundario', 'uf', 'municipio', 'bairro', 'cep', 'porte', 'situacao', 'mei', 'abertura_de', 'abertura_ate', 'capital_min', 'capital_max', 'com_celular', 'com_fixo', 'com_email', 'page', 'limit'];

// errors.ts + empresas.ts + query.ts + auth.ts: status → códigos estáveis do envelope { error, message }
const ERROR_CODES: Record<number, string[]> = {
    400: ['bad_request', 'invalid_parameter', 'filter_required', 'page_out_of_range', 'invalid_cnpj'],
    401: ['unauthorized'],
    402: ['insufficient_credits'],
    403: ['forbidden'],
    404: ['not_found'],
    413: ['payload_too_large'],
    422: ['query_too_broad'],
    429: ['rate_limited'],
    499: ['client_closed_request'],
    500: ['internal_error'],
    503: ['billing_unavailable'],
};

// empresa-dto.ts → EmpresaV2 (chaves permitidas por objeto)
const EMPRESA_SHAPE: Record<string, string[]> = {
    '': ['cnpj', 'razao_social', 'nome_fantasia', 'tipo', 'situacao', 'data_abertura', 'porte', 'natureza_juridica', 'capital_social', 'simples', 'mei', 'cnae_principal', 'cnaes_secundarios', 'endereco', 'telefones', 'email', 'socios'],
    situacao: ['codigo', 'descricao', 'data', 'motivo'],
    porte: ['codigo', 'descricao'],
    natureza_juridica: ['codigo', 'descricao'],
    cnae_principal: ['codigo', 'descricao'],
    cnaes_secundarios: ['codigo', 'descricao'],
    endereco: ['logradouro', 'numero', 'complemento', 'bairro', 'cep', 'municipio', 'uf'],
    'endereco.municipio': ['codigo', 'nome'],
    telefones: ['tipo', 'ddd', 'numero', 'completo'],
    socios: ['nome', 'documento', 'qualificacao', 'data_entrada', 'faixa_etaria'],
    'socios.qualificacao': ['codigo', 'descricao'],
};

function shapeProblems(value: unknown, pathKey = ''): string[] {
    if (Array.isArray(value)) return value.flatMap((v) => shapeProblems(v, pathKey));
    if (!value || typeof value !== 'object') return [];
    const allowed = EMPRESA_SHAPE[pathKey];
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (allowed && !allowed.includes(k)) out.push(`campo inexistente no DTO: ${pathKey || 'empresa'}.${k}`);
        out.push(...shapeProblems(v, pathKey ? `${pathKey}.${k}` : k));
    }
    return out;
}

/** Texto cru de cada bloco de código (pós-realce) com o título da janela. */
async function codeBlocks(page: Page, scope: string): Promise<Array<{ title: string; raw: string }>> {
    return page.locator(`${scope} .codewin`).evaluateAll((wins) =>
        wins.map((w) => ({ title: w.querySelector('.cw-title')?.textContent ?? '', raw: (w.querySelector('pre') as HTMLElement | null)?.dataset.raw ?? '' })));
}

const NAV_ITEMS: Array<[string | RegExp, string]> = [
    ['Introdução', 'introducao'], ['Autenticação', 'autenticacao'], ['Créditos e cobrança', 'creditos'], ['Busca', 'busca'],
    ['Consulta por CNPJ', 'consulta-cnpj'], ['Lote', 'lote'], ['Paginação', 'paginacao'], ['Erros', 'erros'], ['Limites', 'limites'],
    ['Webhooks de entrada', 'webhooks'],
];

test.describe('documentação (docs.html)', () => {
    test('índice lateral tem todas as seções e as âncoras funcionam', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/docs.html');
        const nav = page.locator('#docs-nav');
        for (const [name, id] of NAV_ITEMS) {
            const link = nav.getByRole('link', { name, exact: typeof name === 'string' });
            await expect(link, String(name)).toHaveAttribute('href', `#${id}`);
            await expect(page.locator(`section#${id}`), id).toHaveCount(1);
        }
        expect(await brokenAnchors(page)).toEqual([]);
        for (const [name, id] of NAV_ITEMS) {
            await nav.getByRole('link', { name, exact: typeof name === 'string' }).click();
            await expect(page).toHaveURL(new RegExp(`#${id}$`));
            await expect(page.locator(`section#${id}`)).toBeInViewport({ timeout: 5000 });
        }
    });

    test('índice marca a seção ativa ao rolar', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/docs.html');
        await page.evaluate(() => document.getElementById('erros')!.scrollIntoView({ behavior: 'instant' as ScrollBehavior }));
        await expect(page.locator('#docs-nav a[href="#erros"]')).toHaveClass(/active/, { timeout: 5000 });
    });

    test('cada endpoint da v2 tem curl, parâmetros e exemplo de resposta', async ({ page }) => {
        await page.goto('/docs.html');
        for (const id of ['busca', 'consulta-cnpj', 'lote']) {
            const blocks = await codeBlocks(page, `section#${id}`);
            expect(blocks.some((b) => b.raw.startsWith('curl')), `${id}: curl`).toBe(true);
            const resp = blocks.filter((b) => /resposta/i.test(b.title));
            expect(resp.length, `${id}: resposta`).toBeGreaterThan(0);
            for (const r of resp) expect(() => JSON.parse(r.raw), `${id}: JSON inválido em "${r.title}"`).not.toThrow();
            await expect(page.locator(`section#${id} table`).first(), `${id}: tabela de parâmetros`).toBeVisible();
        }
        await expect(page.locator('section#busca')).toContainText('GET');
        await expect(page.locator('section#lote')).toContainText('POST');
    });

    test('a busca documenta exatamente os parâmetros do query.ts e os curls só usam esses', async ({ page }) => {
        await page.goto('/docs.html');
        const documented = await page.locator('section#busca table').first().locator('tbody tr td:first-child code').allTextContents();
        expect([...documented].sort()).toEqual([...KNOWN_PARAMS].sort());
        const text = await page.locator('section#busca').innerText();
        expect(text).toMatch(/pelo menos um filtro/i);
        expect(text.replace(/\s+/g, ' ')).toMatch(/bairro.*(só|somente).*junto com.*municipio/i);
        // todo curl do GET /v2/empresas usa só parâmetros conhecidos
        for (const scope of ['section#introducao', 'section#busca', 'section#paginacao', 'section#creditos', 'section#limites']) {
            for (const b of await codeBlocks(page, scope)) {
                if (!b.raw.includes('/v2/empresas') || b.raw.includes('/lote') || !b.raw.startsWith('curl')) continue;
                const names = [...b.raw.matchAll(/(?:-d |--data-urlencode '|[?&])([a-z_]+)=/g)].map((m) => m[1]);
                for (const n of names) expect(KNOWN_PARAMS, `${scope}: parâmetro ${n} não existe na v2`).toContain(n);
            }
        }
    });

    test('os exemplos de resposta só têm campos do DTO EmpresaV2', async ({ page }) => {
        await page.goto('/docs.html');
        let checked = 0;
        for (const id of ['introducao', 'busca', 'consulta-cnpj', 'lote', 'objeto-empresa']) {
            for (const b of await codeBlocks(page, `section#${id}`)) {
                if (!/resposta|objeto/i.test(b.title)) continue;
                const json = JSON.parse(b.raw);
                const empresas = json.data ? [].concat(json.data) : [];
                expect(empresas.flatMap((e) => shapeProblems(e)), `${id}: ${b.title}`).toEqual([]);
                checked += empresas.length;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(3);
        // a tabela de campos cobre todo o DTO
        const fields = await page.locator('section#objeto-empresa table').first().locator('tbody tr td:first-child code').allTextContents();
        for (const k of EMPRESA_SHAPE['']) expect(fields.some((f) => f.startsWith(k)), `campo ${k} sem linha na tabela`).toBe(true);
    });

    test('a tabela de erros cobre 400, 401, 402, 403, 404, 422, 429, 499, 500 e 503 com os códigos do errors.ts', async ({ page }) => {
        await page.goto('/docs.html');
        const rows = await page.locator('section#erros table').first().locator('tbody tr').allInnerTexts();
        for (const [status, codes] of Object.entries(ERROR_CODES)) {
            const row = rows.find((r) => r.trim().startsWith(status));
            expect(row, `linha do ${status}`).toBeTruthy();
            for (const c of codes) expect(row, `${status} → ${c}`).toContain(c);
        }
        const text = await page.locator('section#erros').innerText();
        for (const word of ['buy_url', 'required', 'remaining', 'request_error']) expect(text).toContain(word);
        expect(text).toMatch(/499[\s\S]*(nada foi cobrado|sem cobran)/i);
        await expect(page.locator('section#erros')).toContainText('"error"');
    });

    test('regras de cobrança, paginação e limites batem com o código da v2', async ({ page }) => {
        await page.goto('/docs.html');
        const t = async (id: string) => (await page.locator(`section#${id}`).innerText()).replace(/\s+/g, ' ');
        const creditos = await t('creditos');
        expect(creditos).toMatch(/1 crédito = 1 empresa/);
        expect(creditos).toMatch(/200 consultas/);
        expect(creditos).toMatch(/12 meses/);
        expect(creditos).toMatch(/R\$ 0,01/);
        expect(creditos).toMatch(/402/);
        const rows = page.locator('section#creditos tbody[data-plans-table] tr');
        await expect(rows).toHaveCount(8);
        for (const p of SPEC_PLANS) await expect(page.locator(`section#creditos td[data-price="${p.price}"]`)).toContainText(p.brl);
        const pag = await t('paginacao');
        for (const s of ['100', '10.000', 'page_out_of_range', 'data_abertura', 'cnpj']) expect(pag).toContain(s);
        const lim = await t('limites');
        for (const s of ['120', 'Retry-After', '100', '32 KiB', 'query_too_broad']) expect(lim).toContain(s);
        expect(await t('lote')).toMatch(/not_found/);
        expect(await t('lote')).toMatch(/invalid/);
    });

    test('doc da v1 removida do site e webhooks de entrada preservados', async ({ page }) => {
        await page.goto('/docs.html');
        await expect(page.locator('section#legado')).toHaveCount(0);
        await expect(page.locator('section[id^="v1-"]')).toHaveCount(0);
        await expect(page.locator('nav a[href="#legado"], nav a[href^="#v1-"]')).toHaveCount(0);
        await expect(page.locator('aside nav')).not.toContainText('Legado / CRM');
        await expect(page.locator('main')).not.toContainText('Legado / CRM');
        for (const id of ['webhooks-visao-geral', 'webhooks-secret-header', 'webhooks-assinatura', 'webhooks-payload', 'webhooks-deduplicacao', 'webhooks-respostas']) {
            await expect(page.locator(`section#webhooks section#${id}`), id).toHaveCount(1);
        }
        await expect(page.locator('section#webhooks')).toContainText('Starter, Plus, Business e Pro');
        // listas de referência continuam documentadas na busca da v2
        await expect(page.locator('section#busca')).toContainText('listas de referência abertas');
    });

    test('links antigos do domínio (#webhooks-*, #busca-rapida) redirecionam do index para a doc', async ({ page }) => {
        await page.goto('/index.html#webhooks-visao-geral');
        await expect(page).toHaveURL(/\/docs\.html#webhooks-visao-geral$/);
        await page.goto('/index.html#busca-rapida');
        await expect(page).toHaveURL(/\/docs\.html#busca$/);
        await page.goto('/index.html#detalhes-cnpj');
        await expect(page).toHaveURL(/\/docs\.html#consulta-cnpj$/);
    });

    test('0 erros de console, sem concorrente, sem complexidade, sem promessa de atualização', async ({ page }) => {
        const problems = watch(page);
        await page.goto('/docs.html');
        await settle(page);
        const text = await visibleText(page);
        for (const re of FORBIDDEN_COPY) expect(text, String(re)).not.toMatch(re);
        expect(problems).toEqual([]);
    });

    for (const width of WIDTHS) {
        test(`render em ${width}px sem rolagem horizontal`, async ({ page }) => {
            const problems = watch(page);
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/docs.html');
            await settle(page);
            await expectNoHScroll(page);
            if (width < 1024) {
                const side = page.locator('#docs-nav');
                const box = async () => (await side.boundingBox())!;
                expect((await box()).x + (await box()).width).toBeLessThanOrEqual(1);
                await page.locator('#nav-btn').click();
                await expect(side).toHaveClass(/open/);
                await expect.poll(async () => (await box()).x, { timeout: 3000 }).toBeGreaterThanOrEqual(0);
                await page.locator('#docs-nav a[href="#erros"]').click();
                await expect(side).not.toHaveClass(/open/);
            }
            await shot(page, 'docs', width);
            expect(problems).toEqual([]);
        });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// Task 3 — retorno do checkout (contratacao/*). try_files e cabeçalhos: tests/docker-nginx.sh
// ═════════════════════════════════════════════════════════════════════════════
const RETORNO = [
    { slug: 'sucesso', h1: /Recebemos o seu pedido/ },
    { slug: 'cancelada', h1: /Pagamento cancelado/ },
    { slug: 'expirada', h1: /O link de pagamento expirou/ },
];

test.describe('retorno do checkout (contratacao/*)', () => {
    for (const r of RETORNO) {
        test(`${r.slug}: renderiza em 375, 768 e 1440 px, sem erros e fora do índice de busca`, async ({ page }) => {
            const problems = watch(page);
            for (const width of WIDTHS) {
                await page.setViewportSize({ width, height: 900 });
                await page.goto(`/contratacao/${r.slug}.html`);
                await settle(page);
                await expect(page.locator('h1')).toContainText(r.h1);
                await expectNoHScroll(page);
                await shot(page, `contratacao-${r.slug}`, width);
            }
            await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
            const text = await visibleText(page);
            for (const re of FORBIDDEN_COPY) expect(text, String(re)).not.toMatch(re);
            expect(problems).toEqual([]);
        });
    }

    test('sucesso aponta para o painel e avisa que o convite chega por e-mail depois da confirmação', async ({ page }) => {
        await page.goto('/contratacao/sucesso.html');
        await expect(page.getByRole('link', { name: /Ir para o painel da API/ })).toHaveAttribute('href', PAINEL);
        const text = await visibleText(page);
        expect(text).toMatch(/convite.*e-mail/i);
        expect(text).toMatch(/pagamento for confirmado/i);
        expect(text).not.toMatch(/pagamento (foi )?confirmado com sucesso/i);
    });

    for (const slug of ['cancelada', 'expirada']) {
        test(`${slug} volta para os preços`, async ({ page }) => {
            await page.goto(`/contratacao/${slug}.html`);
            const back = page.getByRole('link', { name: /Voltar aos preços|Escolher plano/ });
            await expect(back).toHaveAttribute('href', '/#planos');
            await back.click();
            await expect(page).toHaveURL(/\/#planos$/);
            await expect(page.locator('#planos')).toBeVisible();
        });
    }

    test('páginas de retorno não chamam a api.buscalead.com', async ({ page }) => {
        const toApi: string[] = [];
        page.on('request', (r) => { if (r.url().includes('api.buscalead.com')) toApi.push(r.url()); });
        for (const r of RETORNO) { await page.goto(`/contratacao/${r.slug}.html`); await settle(page); }
        expect(toApi).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cabeçalho fixo: nada passa da borda direita (o scrollWidth da página não pega elemento fixo cortado)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('cabeçalho cabe na janela', () => {
    for (const url of ['/index.html', '/docs.html', '/contratacao/sucesso.html', '/contratacao/cancelada.html', '/contratacao/expirada.html']) {
        test(`${url} em 320, 375 e 768 px`, async ({ page }) => {
            for (const width of [320, 375, 768]) {
                await page.setViewportSize({ width, height: 700 });
                await page.goto(url);
                await settle(page);
                const overflow = await page.evaluate(() =>
                    [...document.querySelectorAll('.hdr *')]
                        .filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().right > window.innerWidth + 0.5)
                        .map((e) => String(e.className || e.tagName)));
                expect(overflow, `${url} @${width}`).toEqual([]);
            }
        });
    }
});
