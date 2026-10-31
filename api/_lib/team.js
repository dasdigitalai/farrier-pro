// Multi-farrier businesses: an owner's account is "the business", and other farriers join it.
//
// A farrier who never invites anyone is a business of one, with nothing stored here, and every
// path behaves exactly as before: businessFor() answers { businessId: their uid, role: 'owner' }.
//
// Where things live (both written only by the server — see firestore.rules):
//   businessMembers/{memberUid}   { businessId, role: 'manager' | 'farrier', email, name, addedBy, addedAt }
//                                 One business per person. The owner has no doc: their uid IS the businessId.
//   businessInvites/{email}       { businessId, businessName, email, name, role, invitedBy, createdAt }
//                                 For an email that already had a FarriTech login when invited; the
//                                 member doc is made when they next sign in (team_accept).
//
// Shared records (invoices, customers, horses, appointments, services, inventory) keep using
// farrierId = businessId. Who did the work is stamped separately (performedBy) by the apps.
// Mileage and Google Calendar stay personal (the member's own uid).
import crypto from 'crypto';
import { getDoc, patchDoc, deleteDoc, queryIn } from './firebase-rest.js';
import { PaymentError } from './invoice-payments.js';

const API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyAQ1LaWG9lE9j5h6X0T0YQKa_j04vJZHE4';
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const APP = (process.env.APP_URL || 'https://app.farritech.com').replace(/\/$/, '');
export const ROLES = ['owner', 'manager', 'farrier'];
const MEMBER_ROLES = ['manager', 'farrier'];
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// The business the caller works in, and their role there.
export async function businessFor(caller) {
  const m = await getDoc(`businessMembers/${caller.uid}`).catch(() => null);
  if (m?.businessId && MEMBER_ROLES.includes(m.role)) return { businessId: m.businessId, role: m.role, member: true };
  return { businessId: caller.uid, role: 'owner', member: false };
}

// Throws unless the caller's role is one of `roles`.
export function requireRole(biz, roles, what) {
  if (!roles.includes(biz.role)) {
    throw new PaymentError(`Only the business owner${roles.includes('manager') ? ' or a manager' : ''} can ${what}.`, 403);
  }
}

async function membersOf(businessId) {
  const rows = await queryIn('businessMembers', 'businessId', [businessId]);
  return rows.map(m => ({ uid: m.id, email: m.email || '', name: m.name || '', role: m.role }));
}
async function invitesOf(businessId) {
  const rows = await queryIn('businessInvites', 'businessId', [businessId]);
  return rows.map(i => ({ email: i.email, name: i.name || '', role: i.role }));
}

// ── team_status: who's in my business (owner and managers see the list) ──
export async function teamStatus(caller) {
  const biz = await businessFor(caller);
  const owner = await getDoc(`farriers/${biz.businessId}`).catch(() => null);
  const out = { businessId: biz.businessId, role: biz.role, member: biz.member, businessName: owner?.businessName || '' };
  if (biz.role === 'owner' || biz.role === 'manager') {
    out.members = await membersOf(biz.businessId);
    out.invites = await invitesOf(biz.businessId);
  }
  return out;
}

// ── team_invite (owner): add a farrier by email ──
// New email → the server makes their login and they get an email to set a password (or they use
// "Sign in with Google" with that address). Existing login → they join when they next sign in,
// unless that login is already a farrier with their own business.
export async function teamInvite(caller, { email, name, role }) {
  const biz = await businessFor(caller);
  requireRole(biz, ['owner'], 'add farriers');
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80);
  role = MEMBER_ROLES.includes(role) ? role : 'farrier';
  if (!emailOk(email)) throw new PaymentError('Enter a valid email address.');
  if (email === caller.email) throw new PaymentError('That’s your own email.');
  const businessId = biz.businessId;
  const owner = await getDoc(`farriers/${businessId}`).catch(() => null);
  const businessName = owner?.businessName || 'your farrier business';
  if ((await membersOf(businessId)).some(m => m.email === email)) throw new PaymentError('That farrier is already on your team.');

  // Try to make the login. EMAIL_EXISTS means they already have one.
  const r = await fetch(`${IDT}/accounts:signUp?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: crypto.randomBytes(24).toString('base64url'), returnSecureToken: false }),
  });
  const d = await r.json().catch(() => ({}));
  let joined = false;
  if (r.ok && d.localId) {
    await patchDoc(`businessMembers/${d.localId}`, { businessId, role, email, name, addedBy: caller.uid, addedAt: new Date() });
    joined = true;
    // Firebase's own "set your password" email (the reset flow works for a brand-new login).
    await fetch(`${IDT}/accounts:sendOobCode?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email, continueUrl: APP }),
    }).catch(() => null);
  } else if (d?.error?.message?.startsWith('EMAIL_EXISTS')) {
    await patchDoc(`businessInvites/${encodeURIComponent(email)}`, { businessId, businessName, email, name, role, invitedBy: caller.uid, createdAt: new Date() });
  } else {
    console.error('team invite signUp failed:', r.status, JSON.stringify(d));
    throw new PaymentError('Couldn’t create a login for that email. Please try again.');
  }
  await sendInviteEmail({ email, name, businessName, role, newLogin: joined }).catch(e => console.warn('Invite email failed:', e.message));
  return { joined, pending: !joined };
}

// ── team_accept: a signed-in person with a pending invite joins that business ──
export async function teamAccept(caller) {
  if (!caller.email) return { joined: false };
  const invite = await getDoc(`businessInvites/${encodeURIComponent(caller.email)}`).catch(() => null);
  if (!invite?.businessId) return { joined: false };
  if (invite.businessId === caller.uid) { await deleteDoc(`businessInvites/${encodeURIComponent(caller.email)}`); return { joined: false }; }
  // Someone who already runs their own FarriTech business can't be folded into another one.
  if (await getDoc(`farriers/${caller.uid}`).catch(() => null)) {
    return { joined: false, error: 'This login already has its own FarriTech business, so it can’t join another one. Ask the owner to invite a different email.' };
  }
  await patchDoc(`businessMembers/${caller.uid}`, {
    businessId: invite.businessId, role: MEMBER_ROLES.includes(invite.role) ? invite.role : 'farrier',
    email: caller.email, name: invite.name || '', addedBy: invite.invitedBy || '', addedAt: new Date(),
  });
  await deleteDoc(`businessInvites/${encodeURIComponent(caller.email)}`);
  return { joined: true, businessId: invite.businessId };
}

// ── team_remove / team_set_role (owner) ──
export async function teamRemove(caller, { uid, email }) {
  const biz = await businessFor(caller);
  requireRole(biz, ['owner'], 'remove farriers');
  if (uid) {
    const m = await getDoc(`businessMembers/${uid}`);
    if (!m || m.businessId !== biz.businessId) throw new PaymentError('That farrier isn’t on your team.', 404);
    await deleteDoc(`businessMembers/${uid}`);
  } else if (email) {
    const inv = await getDoc(`businessInvites/${encodeURIComponent(String(email).toLowerCase())}`);
    if (!inv || inv.businessId !== biz.businessId) throw new PaymentError('No such invite.', 404);
    await deleteDoc(`businessInvites/${encodeURIComponent(String(email).toLowerCase())}`);
  }
  return { removed: true };
}
export async function teamSetRole(caller, { uid, role }) {
  const biz = await businessFor(caller);
  requireRole(biz, ['owner'], 'change roles');
  if (!MEMBER_ROLES.includes(role)) throw new PaymentError('Pick Manager or Farrier.');
  const m = await getDoc(`businessMembers/${uid}`);
  if (!m || m.businessId !== biz.businessId) throw new PaymentError('That farrier isn’t on your team.', 404);
  await patchDoc(`businessMembers/${uid}`, { role });
  return { role };
}

async function sendInviteEmail({ email, name, businessName, role, newLogin }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const steps = newLogin
    ? `We've made your FarriTech login for <strong>${esc(email)}</strong>. You'll get a separate email to set your password, or just use <strong>Sign in with Google</strong> with this address.`
    : `Sign in to FarriTech with <strong>${esc(email)}</strong> (the login you already have) and you'll join automatically.`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#333;max-width:560px;margin:0 auto;padding:20px;">
  <div style="text-align:center;padding:24px;background:#0D1320;border-radius:10px 10px 0 0;"><img src="${APP}/public/farritech_logo_letters_white.png" alt="FarriTech" style="height:44px;"></div>
  <div style="background:#fff;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
    <h2 style="margin:0 0 .5rem;">You've been added to ${esc(businessName)}</h2>
    <p>Hi${name ? ' ' + esc(name.split(' ')[0]) : ''}, you've been added to <strong>${esc(businessName)}</strong> on FarriTech as a ${role === 'manager' ? 'manager' : 'farrier'}.</p>
    <p>${steps}</p>
    <p style="text-align:center;margin:24px 0;"><a href="${APP}" style="background:#2683FB;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">Open FarriTech</a></p>
    <p style="color:#9ca3af;font-size:12px;">If you weren't expecting this, you can ignore this email.</p>
  </div></body></html>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'FarriTech <noreply@farritech.com>', to: [email], subject: `You've been added to ${businessName} on FarriTech`, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
}
