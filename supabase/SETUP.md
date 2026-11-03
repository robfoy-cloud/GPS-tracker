# Turning on sign-in and the route library

Once this is done, everyone has to sign in to use Flightroute, and only the email addresses on your list can. Sign-in is a 6-digit code sent by email, with no passwords. You manage the list from the app (**Settings › People who can use Flightroute**). Flights recorded automatically are then shared to the public route library in this repository.

Until the app has the project's details, it keeps working without sign-in, as before, and nothing is uploaded.

## 1. Use your Learn Spanish Supabase project
Supabase's free plan allows two projects, so Flightroute shares the one Learn Spanish uses. Its tables all start with `fr_`, so the two apps' access lists stay separate: being allowed into one doesn't let anyone into the other.

(If you'd rather keep them apart and have a free slot, create a new project instead and follow the Learn Spanish SETUP.md steps 1, 3, 4 and 5 for it, then come back here.)

## 2. Create Flightroute's access list
1. In Supabase, open the Learn Spanish project, then **SQL Editor › New query**.
2. Paste the whole of `flightroute.sql` (in this folder). Near the end, replace `your.email@example.com` with the email you'll sign in with. That makes you Flightroute's first admin.
3. Press **Run**. It should finish with "Success. No rows returned".

## 3. Make the sign-in email work for both apps
The email template belongs to the project, so it currently says "Learn Spanish". In **Authentication › Emails › Templates**, in both **Confirm signup** and **Magic Link**, change the subject to `Your sign-in code` and the message to:

```html
<h2>Your sign-in code</h2>
<p>Enter this code in the app to sign in:</p>
<p style="font-size:28px;letter-spacing:6px"><b>{{ .Token }}</b></p>
<p>If you didn't ask for it, you can ignore this email.</p>
```

## 4. Let the app upload routes to GitHub
1. On GitHub: your picture › **Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token**.
2. Name it `Flightroute route library`, choose an expiry (up to a year), **Repository access › Only select repositories › GPS-tracker**, and under **Permissions › Repository permissions** set **Contents** to **Read and write**. Generate it and copy the token.
3. In Cloudflare: **Workers & Pages › gps-tracker › Settings › Variables and Secrets › Add**, type **Secret**, name `GITHUB_TOKEN`, paste the token, **Deploy**.

The token can only change files in this one repository, and only the worker can use it. When it expires, uploads pause until you add a new one; nothing else stops working.

## 5. Switch it on
Tell Claude it's done (or put the Learn Spanish project's URL and publishable key into `config.js` and into `vars` in `wrangler.jsonc` yourself; they're the same public values Learn Spanish uses).

## What gets shared
For each automatically recorded flight: the path every kilometre or so, with heights, and the departure and arrival airport codes. No times, dates, names or email addresses. It goes into `routes/` in this public repository, and `routes/index.json` lists the routes for the app. You can turn sharing off in **Settings › Route library**, and delete any route from the repository on github.com.
