# FarriTech - Multi-User Platform Setup Guide

A complete multi-user business management platform for farriers with authentication, Google Calendar sync, unique QR codes, Stripe payments, and SMS notifications.

## 🎯 Key Features

### For Each Farrier:
- ✅ **Individual accounts** with secure login
- ✅ **Unique QR code** for their vehicle/business cards
- ✅ **Personal booking link** (e.g., yoursite.com?farrier=abc123)
- ✅ **Google Calendar integration** - appointments sync automatically
- ✅ **Stripe payment links** in invoices
- ✅ **SMS reminders** to customers
- ✅ **Business KPIs** and reports
- ✅ **Mobile-friendly** dashboard

### Customer Experience:
- Scan QR code → Opens farrier's booking page
- Book appointment → Syncs to farrier's Google Calendar
- Receive SMS confirmations and reminders
- Pay invoices via Stripe links

---

## 📋 Setup Instructions (Step-by-Step)

### Step 1: Firebase Setup (User Accounts & Database)

Firebase provides authentication and database storage for free!

1. **Go to [Firebase Console](https://console.firebase.google.com/)**
2. Click **"Add project"** or **"Create a project"**
3. Enter project name (e.g., "farritech")
4. Disable Google Analytics (optional for now)
5. Click **Create project**

#### Enable Authentication:
1. In Firebase Console, click **Authentication** in left sidebar
2. Click **Get started**
3. Click **Sign-in method** tab
4. Enable **Email/Password**
5. Click **Save**

#### Enable Firestore Database:
1. Click **Firestore Database** in left sidebar
2. Click **Create database**
3. Select **Start in test mode** (for now)
4. Choose location closest to you
5. Click **Enable**

#### Get Your Config:
1. Click the **gear icon** ⚙️ next to Project Overview
2. Click **Project settings**
3. Scroll down to **Your apps** section
4. Click the **</>** (Web) icon
5. Register your app with a nickname
6. **COPY** the firebaseConfig object

7. **Open `index.html`** and replace this section (around line 843):

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

With your actual config values from Firebase.

---

### Step 2: Google Calendar API Setup

This allows appointments to sync to each farrier's Google Calendar.

1. **Go to [Google Cloud Console](https://console.cloud.google.com/)**
2. Create a new project or select existing one
3. Click **"Enable APIs and Services"**
4. Search for **"Google Calendar API"**
5. Click on it and click **Enable**

#### Create OAuth Credentials:
1. Go to **"Credentials"** in left sidebar
2. Click **"Create Credentials"** → **"OAuth client ID"**
3. If prompted, configure OAuth consent screen:
   - User type: **External**
   - App name: **FarriTech**
   - User support email: Your email
   - Add scope: `../auth/calendar`
   - Add test users: Your email
4. Back to Create credentials:
   - Application type: **Web application**
   - Name: **FarriTech Web**
   - Authorized JavaScript origins: Add your domain (e.g., `https://yoursite.netlify.app`)
   - Authorized redirect URIs: Same as above
5. Click **Create**
6. **COPY** your Client ID

7. **Open `index.html`** and replace (around line 859):

```javascript
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID";
```

With your actual Client ID.

---

### Step 3: Stripe Setup (Payments)

1. **Go to [Stripe Dashboard](https://dashboard.stripe.com/)**
2. Sign up or log in
3. Click **Developers** → **API keys**
4. Copy your **Publishable key** (starts with `pk_test_...`)

5. **Open `index.html`** and find the Stripe initialization (you'll need to add this):

```javascript
const stripe = window.Stripe('pk_test_YOUR_PUBLISHABLE_KEY');
```

**Note:** For production, you'll need a backend server to create Payment Links securely. The current code simulates this - see "Backend Setup" section below for production.

---

### Step 4: Deploy to Web

#### Option A: Netlify (Recommended - Easiest)

1. Go to [Netlify Drop](https://app.netlify.com/drop)
2. Drag and drop your entire **`farritech`** folder
3. Get your live URL instantly!
4. Update Firebase and Google Calendar authorized domains with your Netlify URL

#### Option B: Vercel

1. Go to [Vercel](https://vercel.com)
2. Sign up and create new project
3. Upload your files
4. Deploy!

#### Option C: GitHub Pages

1. Create GitHub repo
2. Upload `index.html`
3. Enable Pages in Settings
4. Access via GitHub Pages URL

---

## 🚀 How It Works

### For Farriers:

1. **Sign Up**: Create account with email/password
2. **Connect Google Calendar**: One-click OAuth connection
3. **Get QR Code**: Download unique QR code for vehicle
4. **Receive Bookings**: Customers scan QR → book appointment
5. **Auto-Sync**: Appointments appear in Google Calendar automatically
6. **Manage Business**: View KPIs, send reminders, create invoices

### For Customers:

1. **Scan QR Code**: Opens farrier's personal booking page
2. **Book Appointment**: Choose service, date, time
3. **Get Confirmation**: Receive SMS confirmation
4. **Receive Reminders**: Get SMS reminders before appointment
5. **Pay Invoice**: Click Stripe link in SMS/email to pay

---

## 📱 QR Code Usage

Each farrier gets a unique QR code that links to:
```
https://yoursite.com?farrier=abc123xyz
```

**How to Use:**
1. Farrier logs in → Goes to "My QR Code" tab
2. Downloads high-resolution QR code image
3. Prints on:
   - Vehicle magnetic signs
   - Business cards
   - Flyers
   - Trailer sides
4. Customers scan → Book instantly!

**QR Code Features:**
- High contrast (green & white) for easy scanning
- 300x300px resolution
- Includes farrier's business name
- Direct link to booking page

---

## 🔧 Backend Setup (For Production)

The current app works for demos, but for production you'll need a backend server for:

### 1. Stripe Payment Link Creation

**Why:** Never expose Stripe secret keys in frontend code.

**Solution:** Create a serverless function (Netlify/Vercel Functions):

```javascript
// netlify/functions/create-payment.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const { customer, items, total } = JSON.parse(event.body);
  
  const paymentLink = await stripe.paymentLinks.create({
    line_items: items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: { name: item.description },
        unit_amount: item.amount * 100
      },
      quantity: 1
    }))
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ url: paymentLink.url })
  };
};
```

### 2. SMS Sending (Twilio)

**Setup:**
1. Sign up at [Twilio](https://www.twilio.com)
2. Get Account SID and Auth Token
3. Create serverless function:

```javascript
// netlify/functions/send-sms.js
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

exports.handler = async (event) => {
  const { to, message } = JSON.parse(event.body);
  
  await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE,
    to: to
  });

  return { statusCode: 200, body: 'Sent' };
};
```

#### New-signup text alerts
`/api/notify-signup` (code in `api/_lib/signup-alert.js`, served by `api/send-sms.js`) texts you whenever a new farrier creates a FarriTech account
(business name, contact name, email, phone, city/state). In Vercel → Settings →
Environment Variables, add:

- `SIGNUP_ALERT_PHONE` — the number to text, e.g. `5551234567` (comma-separate several)

It uses the same `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
`TWILIO_MESSAGING_SERVICE_SID` as `api/send-sms.js`. Redeploy after adding the variable.
Each account texts once; the profile is stamped `signupNotifiedAt`.

### 3. Google Calendar Sync

Currently, the OAuth flow connects each farrier's calendar. To actually create/update events:

```javascript
// netlify/functions/calendar-event.js
const { google } = require('googleapis');

exports.handler = async (event) => {
  const { accessToken, eventData } = JSON.parse(event.body);
  
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  const event = await calendar.events.insert({
    calendarId: 'primary',
    resource: {
      summary: eventData.title,
      start: { dateTime: eventData.start },
      end: { dateTime: eventData.end },
      description: eventData.description
    }
  });

  return { statusCode: 200, body: JSON.stringify(event.data) };
};
```

---

## 🔒 Security Best Practices

### Firebase Security Rules

Update Firestore rules to secure user data:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Only authenticated users can read their own data
    match /farriers/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    
    // Anyone can create appointments (customers booking)
    match /appointments/{appointmentId} {
      allow create: if true;
      allow read, update, delete: if request.auth != null && 
        resource.data.farrierId == request.auth.uid;
    }

    // Inventory — no public-create case like appointments has, so every
    // operation (including create) is gated on the farrier's own uid.
    match /inventoryItems/{itemId} {
      allow create: if request.auth != null && request.resource.data.farrierId == request.auth.uid;
      allow read, update, delete: if request.auth != null &&
        resource.data.farrierId == request.auth.uid;
    }

    match /inventoryTransactions/{transactionId} {
      allow create: if request.auth != null && request.resource.data.farrierId == request.auth.uid;
      allow read, update, delete: if request.auth != null &&
        resource.data.farrierId == request.auth.uid;
    }
  }
}
```

### Environment Variables

Never commit secrets! Use environment variables:

**In Netlify/Vercel:**
- Add in dashboard under Settings → Environment Variables
- `STRIPE_SECRET_KEY`
- `TWILIO_SID`
- `TWILIO_TOKEN`
- `TWILIO_PHONE`

---

## 📊 Database Structure

### Firestore Collections:

#### `farriers` Collection:
```javascript
{
  userId: "abc123",
  businessName: "John's Farrier Services",
  email: "john@example.com",
  phone: "+1234567890",
  googleCalendarConnected: true,
  googleAccessToken: "encrypted_token",
  bookingUrl: "https://site.com?farrier=abc123",
  createdAt: timestamp
}
```

#### `appointments` Collection:
```javascript
{
  appointmentId: "xyz789",
  farrierId: "abc123",
  customerName: "Sarah Johnson",
  phone: "+1234567890",
  email: "sarah@example.com",
  service: "Routine Trim",
  requestedDate: "2024-12-15",
  requestedTime: "09:00",
  status: "confirmed", // pending, confirmed, completed, cancelled
  amount: 80,
  googleEventId: "calendar_event_id",
  createdAt: timestamp,
  updatedAt: timestamp
}
```

#### `invoices` Collection:
```javascript
{
  invoiceId: "inv_001",
  farrierId: "abc123",
  appointmentId: "xyz789",
  customerName: "Sarah Johnson",
  items: [
    { description: "Routine Trim", amount: 80 },
    { description: "Travel Fee", amount: 20 }
  ],
  total: 100,
  status: "outstanding", // outstanding, paid
  stripePaymentLink: "https://checkout.stripe.com/...",
  createdAt: timestamp,
  paidAt: timestamp
}
```

---

## 🎨 Customization

### Change Colors:

Edit CSS variables in `index.html`:

```css
:root {
  --primary: #2D5016;      /* Main brand color */
  --primary-light: #4A7C2A;
  --secondary: #D4A574;     /* Secondary accent */
  --accent: #E8773D;        /* Action buttons */
  --bg: #F5F1E8;           /* Background */
}
```

### Add Custom Services:

Update the services array in `CustomerBookingView`:

```javascript
const services = [
  'Routine Trim',
  'Shoeing (All 4)',
  'Your Custom Service',
  // Add more...
];
```

---

## 🐛 Troubleshooting

### "Firebase not configured" error
- Make sure you've replaced the Firebase config with your actual credentials
- Check that Firebase Auth and Firestore are enabled in Firebase Console

### "Google Calendar not connecting"
- Verify Google Calendar API is enabled in Google Cloud Console
- Check that your OAuth Client ID is correct
- Make sure your deployed URL is in authorized JavaScript origins

### QR Code not generating
- Check browser console for errors
- Make sure QRCode library is loading (check network tab)
- Try refreshing the page

### Appointments not syncing to Google Calendar
- Verify farrier has connected their Google Calendar (green indicator)
- Check Google Calendar API quotas in Google Cloud Console
- Implement backend serverless function for production use

---

## 💡 Tips for Success

1. **Test Everything**: Create a test farrier account and test the full booking flow
2. **Mobile First**: Most farriers will use this on their phones - test on mobile!
3. **Print Quality QR Codes**: Use high-resolution prints (300 DPI minimum)
4. **QR Code Placement**: Vehicle sides, business cards, invoices, social media
5. **Customer Education**: Add "Scan to Book" text near QR codes
6. **Regular Backups**: Export Firestore data regularly

---

## 📞 Support Resources

- **Firebase**: https://firebase.google.com/docs
- **Google Calendar API**: https://developers.google.com/calendar
- **Stripe**: https://stripe.com/docs
- **Twilio SMS**: https://www.twilio.com/docs/sms
- **Netlify Functions**: https://docs.netlify.com/functions/overview/
- **QR Code Generator**: Built-in with qrcode.js library

---

## 🚀 Next Steps

1. **Deploy** the app to Netlify/Vercel
2. **Configure** Firebase and Google Calendar APIs
3. **Test** with a demo farrier account
4. **Create** backend functions for Stripe and SMS
5. **Launch** and onboard your first farriers!

---

## 📄 License

Custom solution for farrier business management.

**Created with Claude AI**
