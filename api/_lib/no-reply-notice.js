// Adds a "do not reply" note to emails sent from noreply@farritech.com.
// Skipped when the email already has a reply-to address, since replies reach a real person then.
const NOTICE =
  '<div style="max-width:600px;margin:16px auto 0;padding:0 20px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;">' +
  'Please do not reply to this email. It was sent from an address that is not monitored.' +
  '</div>';

export function withNoReplyNotice(html, replyTo) {
  if (replyTo || !html) return html;
  const i = html.lastIndexOf('</body>');
  return i === -1 ? html + NOTICE : html.slice(0, i) + NOTICE + html.slice(i);
}
