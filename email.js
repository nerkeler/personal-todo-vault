/**
 * 邮件发送模块 - 使用 nodemailer
 */
const nodemailer = require('nodemailer');
const { getFullConfig, isEmailConfigured } = require('./appConfig.js');

function resolveEmailConfig(extra = {}) {
  const patch = extra.email ? extra : { email: extra };
  return getFullConfig(patch).email;
}

function createTransporter(emailConfig) {
  if (!isEmailConfigured(emailConfig)) return null;
  return nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: !!emailConfig.secure,
    auth: { user: emailConfig.user, pass: emailConfig.password },
    connectionTimeout: 10000,
  });
}

function senderAddress(emailConfig) {
  const fromEmail = emailConfig.from || emailConfig.user;
  const fromName = emailConfig.fromName || 'TODO提醒';
  return `"${fromName.replace(/"/g, '\\"')}" <${fromEmail}>`;
}

async function verifyEmailConfig(extra = {}) {
  const emailConfig = resolveEmailConfig(extra);
  const t = createTransporter(emailConfig);
  if (!t) throw new Error('SMTP 未配置完整，请填写服务器、端口、账号和密码');
  await t.verify();
  return { success: true, host: emailConfig.host, user: emailConfig.user };
}

async function sendEmail(to, subject, body, extra = {}) {
  const emailConfig = resolveEmailConfig(extra);
  const t = createTransporter(emailConfig);
  if (!t) throw new Error('SMTP 未配置完整，请填写服务器、端口、账号和密码');
  const recipient = to || emailConfig.recipients;
  if (!recipient) throw new Error('缺少收件人，请在配置中心填写收件人');
  const info = await t.sendMail({
    from: senderAddress(emailConfig),
    to: recipient,
    subject,
    text: body,
  });
  return { success: true, messageId: info.messageId, to: recipient };
}

async function sendTestEmail(to, extra = {}) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  return sendEmail(
    to,
    'TODO App 邮件配置测试',
    `这是一封来自 TODO App 的测试邮件。\n\n如果你收到这封邮件，说明 SMTP 配置可用。\n\n发送时间：${now}`,
    extra,
  );
}

module.exports = { sendEmail, sendTestEmail, verifyEmailConfig, resolveEmailConfig };
