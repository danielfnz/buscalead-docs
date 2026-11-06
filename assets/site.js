/*
 * Portal docs.buscalead.com: planos, interruptor de vendas, CTAs, checkout e utilidades da documentação.
 * Sem build: JS puro, carregado com `defer` em todas as páginas.
 */
(function () {
    'use strict';

    // ── Interruptor de vendas ──────────────────────────────────────────────────────────────────────
    // false: "Assinar", "Comprar avulso" e "Começar grátis" abrem o "Fale com a gente" (WhatsApp) e mostram
    // o selo "em breve"; nenhuma requisição vai à api.buscalead.com.
    // true: "Começar grátis" leva ao cadastro e os botões de compra seguem o checkout público (Plano B).
    // Só vire para true depois que o Plano B (checkout público da API), o painel (Plano C) e a v2 (Plano A)
    // estiverem no ar.
    const SALES_OPEN = false;

    const API_BASE = 'https://api.buscalead.com';
    const REGISTER_URL = 'https://buscalead.com/auth/register?returnUrl=%2Fapi%2Fpainel';
    const WHATSAPP = '5534992885263'; // número oficial (buscalead-front: footer, auth e billing-settings)

    // Fonte única de preço do HTML (spec §6.2; `code` = seed de api_plans). O JSON-LD do index.html casa com ela.
    const PLANS = Object.freeze([
        { code: 'basico_1', name: 'Básico 1', price: 29.9, credits: 5000 },
        { code: 'basico_2', name: 'Básico 2', price: 59.9, credits: 12000 },
        { code: 'basico_3', name: 'Básico 3', price: 99.9, credits: 25000 },
        { code: 'intermediario_1', name: 'Intermediário 1', price: 199.9, credits: 70000 },
        { code: 'intermediario_2', name: 'Intermediário 2', price: 499.9, credits: 250000 },
        { code: 'intermediario_3', name: 'Intermediário 3', price: 749.9, credits: 500000 },
        { code: 'avancado_1', name: 'Avançado 1', price: 999.9, credits: 1000000 },
        { code: 'avancado_2', name: 'Avançado 2', price: 1999.9, credits: 3000000 },
    ].map(Object.freeze));
    // Avulso (spec §6.2 e Plano B R-B6): R$ 0,01 por empresa, de R$ 10,00 a R$ 1.000,00 por compra.
    const TOPUP = Object.freeze({ pricePerCredit: 0.01, minCredits: 1000, maxCredits: 100000 });

    window.BUSCALEAD_API_PLANS = PLANS;
    window.BUSCALEAD_API_TOPUP = TOPUP;
    window.BUSCALEAD_SALES_OPEN = SALES_OPEN;

    // ── utilidades ─────────────────────────────────────────────────────────────────────────────────
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const int = (n) => n.toLocaleString('pt-BR');
    const planByCode = (code) => PLANS.find((p) => p.code === code);
    // R$ por consulta com 2 algarismos significativos (0,006 · 0,0029 · 0,00067), como na tabela da spec §6.2.
    const perCredit = (p) => Number((p.price / p.credits).toPrecision(2)).toLocaleString('pt-BR', { maximumFractionDigits: 5 });
    const waLink = (topic) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Olá! Quero saber mais sobre a API de dados da BuscaLead${topic ? ` (${topic})` : ''}.`)}`;
    const topupMoney = (credits) => money(Math.round(credits * TOPUP.pricePerCredit * 100) / 100);

    // ── planos ─────────────────────────────────────────────────────────────────────────────────────
    function planCard(p, maxCredits) {
        const [whole, cents] = p.price.toFixed(2).split('.');
        // escala logarítmica de volume (1 mil → 3 milhões) só para dar ritmo visual à grade
        const width = Math.max(4, (Math.log(p.credits / 1000) / Math.log(maxCredits / 1000)) * 100);
        return `<article class="plan" data-plan="${p.code}">
  <h4>${esc(p.name)}</h4>
  <p class="price" data-price="${p.price.toFixed(2)}"><span class="cur">R$&nbsp;</span><span class="int">${int(Number(whole))}</span><span class="dec">,${cents}</span><span class="per">/mês</span></p>
  <p class="credits"><strong>${int(p.credits)}</strong> consultas por mês</p>
  <p class="unit">R$ ${perCredit(p)} por consulta</p>
  <div class="bar" aria-hidden="true"><i style="width:${width.toFixed(1)}%"></i></div>
  <a class="btn btn-secondary btn-block" href="${waLink(p.name)}" data-cta="subscribe" data-plan="${p.code}">Assinar</a>
</article>`;
    }

    function topupCard() {
        return `<article class="plan topup" data-plan="avulso">
  <h4>Avulso</h4>
  <p class="price" data-price="${TOPUP.pricePerCredit.toFixed(2)}"><span class="cur">R$&nbsp;</span><span class="int">0</span><span class="dec">,01</span><span class="per">por empresa</span></p>
  <p class="credits"><strong>Sem assinatura:</strong> compre de R$&nbsp;${topupMoney(TOPUP.minCredits)} a R$&nbsp;${topupMoney(TOPUP.maxCredits)} por vez</p>
  <p class="unit">no cartão ou PIX</p>
  <p class="fine">Os créditos avulsos valem 12 meses e entram na conta junto com os do plano.</p>
  <div class="push"></div>
  <a class="btn btn-secondary btn-block" style="margin-top:1rem" href="${waLink('créditos avulsos')}" data-cta="topup">Comprar avulso</a>
</article>`;
    }

    function renderPlans() {
        const grid = $('#planos-grid');
        if (grid) {
            const maxCredits = Math.max(...PLANS.map((p) => p.credits));
            const tiers = [];
            PLANS.forEach((p) => {
                const tier = p.name.split(' ')[0];
                let group = tiers.find((t) => t.tier === tier);
                if (!group) tiers.push((group = { tier, items: [] }));
                group.items.push(p);
            });
            grid.innerHTML = tiers.map((t, i) => {
                const lo = t.items[0].credits;
                const hi = t.items[t.items.length - 1].credits;
                const cards = t.items.map((p) => planCard(p, maxCredits)).join('');
                const extra = i === tiers.length - 1 ? topupCard() : '';
                return `<div class="tier"><div class="tier-label"><h3>${esc(t.tier)}</h3><span>${int(lo)} a ${int(hi)} consultas/mês</span></div><div class="tier-grid">${cards}${extra}</div></div>`;
            }).join('');
        }
        const body = $('[data-plans-table]');
        if (body) {
            body.innerHTML = PLANS.map((p) =>
                `<tr><td><strong>${esc(p.name)}</strong> <code class="ic">${p.code}</code></td><td data-price="${p.price.toFixed(2)}">R$&nbsp;${money(p.price)}</td><td>${int(p.credits)}</td><td>R$&nbsp;${perCredit(p)}</td></tr>`).join('');
        }
    }

    // ── diálogos ───────────────────────────────────────────────────────────────────────────────────
    const hasDialog = typeof HTMLDialogElement === 'function';

    function dialog(id, labelId, html) {
        let d = document.getElementById(id);
        if (!d) {
            d = document.createElement('dialog');
            d.id = id;
            d.className = 'dlg';
            d.setAttribute('aria-labelledby', labelId);
            document.body.appendChild(d);
            d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // clique no fundo fecha
        }
        d.innerHTML = `<button type="button" class="dlg-x" aria-label="Fechar" data-close><i class="ri-close-line"></i></button><div class="dlg-body">${html}</div>`;
        $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => d.close()));
        return d;
    }

    function openContact(topic, intro) {
        const d = dialog('dlg-contact', 'dlg-contact-title', `
<h2 id="dlg-contact-title">Fale com a gente</h2>
<p class="sub">${esc(intro)}</p>
<a class="btn btn-primary btn-block" style="margin-top:1.25rem" href="${waLink(topic)}" target="_blank" rel="noopener"><i class="ri-whatsapp-line"></i> Chamar no WhatsApp</a>`);
        d.showModal();
    }

    function fieldsHtml() {
        return `
<label class="fld"><span>Nome</span><input name="nome" autocomplete="name" required></label>
<label class="fld"><span>E-mail</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
<label class="fld"><span>WhatsApp (opcional)</span><input name="whatsapp" type="tel" autocomplete="tel" inputmode="tel"></label>
<label class="fld"><span>Empresa (opcional)</span><input name="companyName" autocomplete="organization"></label>`;
    }

    const legalHtml = `<p class="legal">Ao continuar, você concorda com os <a href="https://buscalead.com/termos-de-uso" target="_blank" rel="noopener">Termos de uso</a> e a <a href="https://buscalead.com/politica-de-privacidade" target="_blank" rel="noopener">Política de privacidade</a>. O convite para definir a senha chega por e-mail depois da confirmação do pagamento.</p>`;

    function openCheckout(kind, plan) {
        const sub = kind === 'subscribe';
        const title = sub ? `Assinar ${plan.name}` : 'Comprar créditos avulsos';
        const summary = sub
            ? `<div class="sum"><strong>R$ ${money(plan.price)}</strong> por mês · ${int(plan.credits)} consultas<br>Pagamento no cartão de crédito, com cobrança mensal. Cancele quando quiser.</div>`
            : `<label class="fld"><span>Quantidade de créditos</span><input name="credits" type="number" min="${TOPUP.minCredits}" max="${TOPUP.maxCredits}" step="1" value="5000" inputmode="numeric"></label>
<div class="chips">${[1000, 5000, 10000, 50000, 100000].map((c) => `<button type="button" class="chip" data-credits="${c}">${int(c)}</button>`).join('')}</div>
<div class="sum">Total: <strong data-total>R$ ${topupMoney(5000)}</strong> · R$ 0,01 por empresa consultada · cartão ou PIX</div>`;
        const d = dialog('dlg-checkout', 'dlg-checkout-title', `
<h2 id="dlg-checkout-title">${esc(title)}</h2>
<form novalidate>
  ${summary}
  ${fieldsHtml()}
  <p class="err" role="alert" hidden></p>
  <button class="btn btn-primary btn-block" style="margin-top:1.25rem" type="submit">Ir para o pagamento <i class="ri-arrow-right-line arrow"></i></button>
  ${legalHtml}
</form>`);
        const form = $('form', d);
        const credits = form.elements.credits;
        const showTotal = () => { const t = $('[data-total]', d); if (t && credits) t.textContent = `R$ ${topupMoney(Number(credits.value) || 0)}`; };
        if (credits) {
            credits.addEventListener('input', showTotal);
            $$('[data-credits]', d).forEach((b) => b.addEventListener('click', () => { credits.value = b.dataset.credits; showTotal(); }));
        }
        form.addEventListener('submit', (e) => { e.preventDefault(); submitCheckout(form, kind, plan); });
        d.showModal();
        form.elements.nome.focus();
    }

    // ── checkout público (Plano B) ─────────────────────────────────────────────────────────────────
    async function postJson(path, body) {
        const res = await fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let data = null;
        try { data = await res.json(); } catch (_) { /* corpo vazio ou não JSON: vale só o status */ }
        if (!res.ok) throw Object.assign(new Error((data && data.message) || 'Não foi possível continuar.'), { status: res.status });
        return data;
    }

    const startSession = (buyer) => postJson('/v1/public-checkout/start', Object.assign({ product: 'api' }, buyer)).then((d) => d.token);

    async function createPayment(kind, payload, buyer) {
        const path = kind === 'subscribe' ? '/v1/public-checkout/api-subscription' : '/v1/public-checkout/api-topup';
        let token = await startSession(buyer);
        try {
            return await postJson(path, Object.assign({ token }, payload));
        } catch (e) {
            if (e.status !== 401) throw e;
            token = await startSession(buyer); // o token vale 30 min: reinicia o fluxo uma vez
            return postJson(path, Object.assign({ token }, payload));
        }
    }

    function failMessage(e) {
        if (e.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
        if (e.status) return e.message;
        return 'Não conseguimos falar com o servidor agora. Tente de novo ou fale com a gente no WhatsApp.';
    }

    async function submitCheckout(form, kind, plan) {
        const err = $('.err', form);
        const btn = $('button[type="submit"]', form);
        const say = (msg) => { err.textContent = msg; err.hidden = !msg; };
        say('');
        const v = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');
        if (v('nome').length < 2) return say('Informe seu nome.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) return say('Informe um e-mail válido.');
        const buyer = { email: v('email'), nome: v('nome') };
        if (v('whatsapp')) buyer.whatsapp = v('whatsapp');
        if (v('companyName')) buyer.companyName = v('companyName');

        let payload;
        if (kind === 'subscribe') {
            payload = { plan_code: plan.code };
        } else {
            const credits = Number(v('credits'));
            if (!Number.isInteger(credits) || credits < TOPUP.minCredits || credits > TOPUP.maxCredits) {
                return say(`Informe de ${int(TOPUP.minCredits)} a ${int(TOPUP.maxCredits)} créditos (de R$ ${topupMoney(TOPUP.minCredits)} a R$ ${topupMoney(TOPUP.maxCredits)}).`);
            }
            payload = { credits };
        }

        btn.disabled = true;
        try {
            const { payment_url: paymentUrl } = await createPayment(kind, payload, buyer);
            const target = new URL(paymentUrl); // só https: nada de javascript: vindo de resposta adulterada
            if (target.protocol !== 'https:') throw new Error('Link de pagamento inválido.');
            btn.textContent = 'Redirecionando…';
            window.location.assign(target.href);
        } catch (e) {
            btn.disabled = false;
            say(failMessage(e));
        }
    }

    // Com vendas abertas, confere o catálogo da API com o array do HTML; divergência só avisa no console.
    async function checkCatalog() {
        try {
            const res = await fetch(`${API_BASE}/v1/public-checkout/api-plans`);
            const catalog = await res.json();
            PLANS.forEach((p) => {
                const remote = (catalog.plans || []).find((r) => r.code === p.code);
                if (!remote || Number(remote.month_price) !== p.price || Number(remote.monthly_credits) !== p.credits) {
                    console.warn(`[portal] catálogo diverge do HTML no plano ${p.code}:`, remote || 'ausente');
                }
            });
            const t = catalog.topup || {};
            if (t.min_credits !== TOPUP.minCredits || t.max_credits !== TOPUP.maxCredits || Number(t.price_per_credit) !== TOPUP.pricePerCredit) {
                console.warn('[portal] catálogo diverge do HTML no avulso:', t);
            }
        } catch (e) {
            console.warn('[portal] não foi possível conferir o catálogo de planos:', e);
        }
    }

    // ── CTAs ───────────────────────────────────────────────────────────────────────────────────────
    function initCtas() {
        $$('[data-cta]').forEach((el) => {
            const cta = el.dataset.cta;
            if (cta === 'contact') return;
            if (!SALES_OPEN) {
                el.insertAdjacentHTML('beforeend', ' <span class="soon">em breve</span>');
            } else if (cta === 'register') {
                el.href = REGISTER_URL;
            }
        });
        document.addEventListener('click', (e) => {
            const el = e.target.closest('[data-cta]');
            if (!el || !hasDialog) return; // sem <dialog>: o href (WhatsApp ou cadastro) segue como link normal
            const cta = el.dataset.cta;
            const plan = planByCode(el.dataset.plan);
            if (cta === 'contact') { e.preventDefault(); return openContact('', 'Chame a gente no WhatsApp para falar sobre a API de dados.'); }
            if (SALES_OPEN && cta === 'register') return; // navega ao cadastro
            e.preventDefault();
            if (SALES_OPEN) return openCheckout(cta, plan);
            const soon = 'A contratação pelo site abre em breve. Enquanto isso, fale com a gente no WhatsApp.';
            if (cta === 'register') return openContact('teste grátis', `Teste grátis de 200 consultas por 7 dias. ${soon}`);
            if (cta === 'topup') return openContact('créditos avulsos', `Créditos avulsos a R$ 0,01 por empresa. ${soon}`);
            return openContact(plan.name, `Plano ${plan.name}: R$ ${money(plan.price)} por mês, ${int(plan.credits)} consultas. ${soon}`);
        });
    }

    // ── blocos de código (realce simples, sem biblioteca) ──────────────────────────────────────────
    const RE = {
        json: /("(?:[^"\\]|\\.)*")(\s*:)?|(\/\/.*$)|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g,
        bash: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(#.*$)|(\bcurl\b)|(\s)(--?[A-Za-z][\w-]*)/g,
        js: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*$)|(\b(?:const|let|await|async|import|from|return|function|new|of|if|else|throw|try|catch)\b)|(\b(?:true|false|null|undefined)\b)|(-?\b\d+(?:\.\d+)?\b)/g,
        py: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#.*$)|(\b(?:import|from|def|return|print|with|as|if|else|raise|for|in)\b)|(\b(?:True|False|None)\b)|(-?\b\d+(?:\.\d+)?\b)/g,
    };

    function token(lang, m) {
        const t = esc(m[0]);
        if (lang === 'json') {
            if (m[1]) return m[2] ? `<span class="tk-k">${esc(m[1])}</span>${esc(m[2])}` : `<span class="tk-s">${t}</span>`;
            return `<span class="${m[3] ? 'tk-c' : 'tk-n'}">${t}</span>`;
        }
        if (lang === 'bash') {
            if (m[1]) return `<span class="tk-s">${t}</span>`;
            if (m[2]) return `<span class="tk-c">${t}</span>`;
            if (m[3]) return `<span class="tk-cmd">${t}</span>`;
            return `${esc(m[4])}<span class="tk-f">${esc(m[5])}</span>`;
        }
        return `<span class="${m[1] ? 'tk-s' : m[2] ? 'tk-c' : m[3] ? 'tk-f' : 'tk-n'}">${t}</span>`;
    }

    function highlight(lang, line) {
        const re = RE[lang];
        if (!re) return esc(line);
        let out = '';
        let last = 0;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(line))) {
            out += esc(line.slice(last, m.index)) + token(lang, m);
            last = re.lastIndex;
        }
        return out + esc(line.slice(last));
    }

    function copyText(btn, text) {
        const label = btn.innerHTML;
        const flash = (html) => { btn.innerHTML = html; setTimeout(() => { btn.innerHTML = label; }, 1800); };
        if (!navigator.clipboard) return flash('Copie manualmente');
        navigator.clipboard.writeText(text).then(() => flash('<i class="ri-check-line"></i> Copiado'), () => flash('Copie manualmente'));
    }

    // Blocos novos: <pre data-code data-lang="json|bash|js|py" data-title="..." [data-bare] [data-hl="3,5"]>texto</pre>.
    // Marcador no fim da linha: `//@grupo` agrupa (explorador); `//@hl` destaca a linha.
    function upgradeCode() {
        $$('pre[data-code]').forEach((pre) => {
            const lang = pre.dataset.lang || 'text';
            const hl = new Set((pre.dataset.hl || '').split(',').filter(Boolean).map(Number));
            const lines = pre.textContent.replace(/^\n+|\s+$/g, '').split('\n').map((text, i) => {
                const m = text.match(/\s*\/\/@(\w+)$/);
                const group = m ? m[1] : null;
                return { text: m ? text.slice(0, m.index) : text, group: group === 'hl' ? null : group, hl: hl.has(i + 1) || group === 'hl' };
            });
            const raw = lines.map((l) => l.text).join('\n');
            pre.dataset.raw = raw;
            pre.innerHTML = lines.map((l) =>
                `<span class="ln${l.hl ? ' hl' : ''}"${l.group ? ` data-g="${l.group}"` : ''}>${highlight(lang, l.text) || ' '}</span>`).join('');
            pre.removeAttribute('data-code');
            if (pre.hasAttribute('data-bare')) return;
            const win = document.createElement('div');
            win.className = 'codewin';
            win.innerHTML = `<div class="cw-head"><span class="cw-title">${esc(pre.dataset.title || lang)}</span><button type="button" class="cw-copy"><i class="ri-file-copy-line"></i> Copiar</button></div><div class="cw-body"></div>`;
            pre.replaceWith(win);
            $('.cw-body', win).appendChild(pre);
            $('.cw-copy', win).addEventListener('click', (e) => copyText(e.currentTarget, raw));
        });
        $$('[data-copy]').forEach((btn) => btn.addEventListener('click', () => {
            const target = $(btn.dataset.copy);
            if (target) copyText(btn, target.dataset.raw || target.textContent);
        }));
    }

    // Blocos legados (doc da v1 e dos webhooks): o botão já está no HTML com onclick="copyCode(this)".
    window.copyCode = function (btn) {
        copyText(btn, btn.closest('.code-window').querySelector('code').innerText);
    };

    // ── explorador da resposta (index) ─────────────────────────────────────────────────────────────
    function initExplorer() {
        $$('[data-explorer]').forEach((box) => {
            const buttons = $$('button[data-group]', box.closest('[data-explorer-root]') || document);
            const apply = (group) => {
                box.dataset.focus = group;
                $$('.ln', box).forEach((l) => {
                    const on = l.dataset.g === group;
                    l.classList.toggle('hl', on);
                    l.classList.toggle('dim', !!l.dataset.g && !on);
                });
                buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === group)));
            };
            buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.group)));
            apply(box.dataset.focus || buttons[0].dataset.group);
        });
    }

    // ── abas (docs: primeira chamada em curl, Node.js e Python) ────────────────────────────────────
    function initTabs() {
        $$('[data-tabs]').forEach((root) => {
            const tabs = $$('[role="tab"]', root);
            const select = (tab) => tabs.forEach((t) => {
                const on = t === tab;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
                document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
            });
            tabs.forEach((t, i) => {
                t.addEventListener('click', () => select(t));
                t.addEventListener('keydown', (e) => {
                    const next = { ArrowRight: i + 1, ArrowLeft: i - 1 }[e.key];
                    if (next === undefined) return;
                    const target = tabs[(next + tabs.length) % tabs.length];
                    target.focus();
                    select(target);
                });
            });
            select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0]);
        });
    }

    // ── cabeçalho e índice da documentação ─────────────────────────────────────────────────────────
    function initChrome() {
        const menuBtn = $('#menu-btn');
        const mnav = $('#mnav');
        if (menuBtn && mnav) {
            menuBtn.addEventListener('click', () => {
                mnav.hidden = !mnav.hidden;
                menuBtn.setAttribute('aria-expanded', String(!mnav.hidden));
            });
            mnav.addEventListener('click', (e) => { if (e.target.closest('a')) mnav.hidden = true; });
        }
        const side = $('#docs-nav');
        const navBtn = $('#nav-btn');
        if (side && navBtn) {
            navBtn.addEventListener('click', () => {
                side.classList.toggle('open');
                navBtn.setAttribute('aria-expanded', String(side.classList.contains('open')));
            });
            side.addEventListener('click', (e) => { if (e.target.closest('a')) { side.classList.remove('open'); navBtn.setAttribute('aria-expanded', 'false'); } });
            const links = $$('.nav-a', side);
            const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
            const mark = (id) => { links.forEach((a) => a.classList.toggle('active', a === byId.get(id))); };
            if ('IntersectionObserver' in window) {
                const io = new IntersectionObserver((entries) => {
                    entries.filter((en) => en.isIntersecting && byId.has(en.target.id)).forEach((en) => mark(en.target.id));
                }, { rootMargin: '-15% 0px -75% 0px' });
                $$('section[id]').forEach((s) => io.observe(s));
            }
            if (location.hash && byId.has(location.hash.slice(1))) mark(location.hash.slice(1));
        }
    }

    function init() {
        renderPlans();
        initCtas();
        upgradeCode();
        initExplorer();
        initTabs();
        initChrome();
        if (SALES_OPEN) checkCatalog();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
