// ─── Proteção por senha do dashboard ───
// Uma senha única (APP_PASSWORD no Railway) protege o app inteiro.
// Sessão via cookie assinado (HMAC) com validade de 30 dias — sem banco de sessões.
//
// Variáveis:
//   APP_PASSWORD → a senha de acesso. SEM ela, o app fica bloqueado (seguro por padrão).
//
// Nota: a rota /uploads (fotos) também fica protegida, exceto nada — tudo exige login.

import crypto from 'crypto';

const SENHA = process.env.APP_PASSWORD;
const DIAS_SESSAO = 30;

// chave de assinatura derivada da própria senha (estável entre deploys,
// e trocar a senha invalida todas as sessões automaticamente)
const chave = () => crypto.createHash('sha256').update('lk-sessao::' + (SENHA || '')).digest();

function assinar(payload) {
  const mac = crypto.createHmac('sha256', chave()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function validarToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const esperado = assinar(payload);
  // comparação em tempo constante
  if (token.length !== esperado.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado))) return false;
  const expira = parseInt(payload, 10);
  return Number.isFinite(expira) && Date.now() < expira;
}

function lerCookie(req, nome) {
  const raw = req.headers.cookie || '';
  for (const par of raw.split(';')) {
    const [k, ...v] = par.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function criarSessao(res) {
  const expira = Date.now() + DIAS_SESSAO * 86400000;
  const token = assinar(String(expira));
  res.setHeader('Set-Cookie',
    `lk_sessao=${encodeURIComponent(token)}; Path=/; Max-Age=${DIAS_SESSAO * 86400}; HttpOnly; SameSite=Lax`);
}

export function encerrarSessao(res) {
  res.setHeader('Set-Cookie', 'lk_sessao=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}

export function senhaCorreta(tentativa) {
  if (!SENHA || !tentativa) return false;
  const a = Buffer.from(String(tentativa));
  const b = Buffer.from(SENHA);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const senhaConfigurada = () => !!SENHA;

// Middleware: exige sessão válida para tudo, exceto a própria tela de login.
export function exigirLogin(req, res, next) {
  if (req.path === '/login' || req.path === '/logout') return next();
  if (validarToken(lerCookie(req, 'lk_sessao'))) return next();
  res.redirect('/login');
}
