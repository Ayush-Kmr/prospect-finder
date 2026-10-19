# Manual acceptance checklist

These steps cover what automation can't: live LinkedIn markup, Chrome's permission prompts, the toolbar click and the right-click menu.

## 1. Load the extension
```bash
cd /Users/ayushkumar/Desktop/AppoloAI_Rev_Eng/zero-cost-extension
npm install && npm run build
```
1. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the `dist/` folder.
2. After any rebuild, click the **↻** on the extension's card.

- [ ] The card shows "Zero-Cost Email Finder" with no red **Errors** button.

## 2. Pin it
Click the puzzle-piece icon in the toolbar, then the pin next to **Zero-Cost Email Finder**.

## 3. Open the consoles
- [ ] **Popup console:** open the popup, right-click inside it → **Inspect**. (The popup stays open while DevTools is attached.)
- [ ] **Service-worker console:** on `chrome://extensions`, click **service worker** on the extension's card. Run `chrome.storage.session.get(null).then(console.log)` to see the current lookup. Nothing should be in `chrome.storage.local`: `chrome.storage.local.get(null).then(console.log)` returns `{}`.

## 4. Test a LinkedIn profile
Use 3–5 real profiles of different kinds:
- a recruiter at a large company
- someone at a small startup
- a profile with several current positions
- someone who recently changed jobs
- a non-English profile

For each:
- [ ] Click the extension icon on the profile. Name, role and **current** company appear within about 4 seconds.
- [ ] If the company is wrong, the **Not this employer?** chips offer the alternatives; **Edit** works.
- [ ] Close and reopen the popup: your edits are still there.
- [ ] On a non-profile LinkedIn page (feed, search), the popup says **Profile not detected** and offers manual entry.

## 5. Check company detection
- [ ] Press **FIND PROFESSIONAL EMAIL**. The "Company domain resolved" step shows a domain and a confidence level.
- [ ] For a well-known company, it's the real domain at **high** confidence.
- [ ] For an obscure company, you're asked to confirm or enter the website. A typed website (e.g. `example.com`) is used after you click **Use**.
- [ ] If the company's email domain differs from its website, the domain card shows `email: …`, with "(unconfirmed)" when it was inferred.

## 6. Check email discovery
- [ ] **Without site access:** the result is labelled **Predicted** or **Pattern-supported — mailbox not verified**, and a **Permission needed** card appears.
- [ ] **Allow & scan:** Chrome shows a permission prompt for that site. Accept it. Even if the popup closes, reopening it shows the scan running or finished. The "Public sources checked" step lists the pages read.
- [ ] **VIEW EVIDENCE:** every **Publicly confirmed** result has a clickable source link that really shows the address. Predictions say "No public evidence" or link to pages showing the company's format.
- [ ] Generic addresses like info@ or careers@ never appear as the person's email.
- [ ] **COPY EMAIL** pastes correctly elsewhere.
- [ ] **Cancel** during a search returns to the Find button, with "Lookup cancelled."
- [ ] **Search yourself:** open **Google** ("open all searches in a new window"), open one or two result pages, click the extension on a result page, and use **Analyze current tab** or **Analyze all open result tabs**. Right-click a page → **Email Finder: analyze this page** puts a number on the toolbar badge.
- [ ] **Offline:** turn off Wi-Fi and press Find. The popup says you're offline, with no fake results.
- [ ] **Clear:** after pressing it, `chrome.storage.session.get(null)` in the service-worker console returns `{}`.

## 7. Report an incorrect result
Copy this, fill it in, and paste it back to me:
```
Profile type: (recruiter at large co / startup / multiple positions / non-English …)
What the popup detected: name / role / company
Expected: name / role / company / domain
Domain step text:
Result: email + status label + evidence score
VIEW EVIDENCE: the source URLs shown (or "none")
Pages checked: statuses (read / blocked / disallowed / timed out)
Console errors: (popup or service worker)
```
Before sharing, replace real people's names and emails with placeholders if you prefer. The structure of the problem is what matters.
