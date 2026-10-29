# job-bot

Ye bot local machine pe chalta hai. Ye UAE, Saudi aur Netherlands ki jobs dhoondta hai, unhein filter aur score karta hai, har job ke liye sahi CV version chunta hai aur track karta hai ke kahan apply kiya.

## Dashboard (rozana yahin se kaam)

```bash
npm run web          # http://localhost:3100
```

- **Tabs**: Matching, Prepared, Applied, Interview, Offer, Rejected, Skipped aur Filtered out. "Filtered out" mein har job ke saath wajah likhi hoti hai.
- **Filters**: search, country aur minimum score.
- **Fetch new jobs**: bot ka `fetch` chalata hai (taqreeban 1 minute).
- **Har job pe**: Open job ↗, Prepare CV + letter, CV download, Mark applied, Skip, Got interview, Rejected, Offer.
- **Job page**: poori description, cover letter (Copy button), notes aur status ki history.
- **Posted on**: ek hi job kai sites pe ho (company site, LinkedIn, Bayt, Himalayas...) to list mein ek hi dafa aati hai. Us pe har site ka tag aur link hota hai.
  - Ek hi job ka matlab hai: company aur title same, aur country same. Remote copy onsite wali ke saath jud jati hai.
  - Main row company ki apni site wali hoti hai. Agar aap kisi copy pe pehle kaam (prepare/apply) kar chuke hon to wahi main rehti hai.

Dashboard ke liye PostgreSQL (DBngin) chalu hona chahiye.

## Database (PostgreSQL)

- Database: `job_bot` (`postgres://postgres@127.0.0.1:5432/job_bot`, `.env` aur `web/.env.local` mein).
- `jobs`: har posting, score, matched/missing skills, visa ki wajah, filter ki wajah, status, CV version, cover letter aur notes.
- `fetch_runs`: har fetch mein kitni postings check hui, kitni nayi aayi aur kya errors aaye.
- `job_events`: har status change ki history (kab prepared, applied, interview...).
- Tables khud ban jati hain (`src/schema.sql`), koi migration command nahi chalani.

## CLI (terminal se)

```bash
npm run bot -- fetch                    # company job boards se nayi jobs
npm run bot -- list                     # matching jobs, score ke hisaab se
npm run bot -- list --country NL --min 60
npm run bot -- show <id> --full         # poori job description
npm run bot -- prepare <id>             # CV version + cover letter tayyar
npm run bot -- mark <id> applied        # apply karne ke baad
npm run bot -- mark <id> interview "HR call Monday"
npm run bot -- list --status applied
npm run bot -- list --status filtered   # kyun reject hui (language, visa, stack...)
npm run bot -- stats
```

Mahine mein ek dafa IND sponsor list refresh karein: `npm run bot -- sponsors:update`

## Rozana automatic fetch (subah 9 baje)

- Mac ka launchd job `~/Library/LaunchAgents/com.abdulrehman.job-bot.fetch.plist` rozana `scripts/daily-fetch.sh` chalata hai. Agar Mac 9 baje so raha ho to jaagne pe chalta hai.
- Fetch ke baad Mac pe notification aati hai. Log `data/fetch.log` mein milta hai.
- Abhi foran chalana ho:

```bash
launchctl kickstart gui/$(id -u)/com.abdulrehman.job-bot.fetch
```

- Band karna ho:

```bash
launchctl bootout gui/$(id -u)/com.abdulrehman.job-bot.fetch
```

- Project `~/job-bot` mein hai, Desktop pe nahi. macOS background jobs ko Desktop parhne nahi deta.

## CV versioning

```
cv/original/AbdulRehmanDarResume.pdf         asli file, kabhi nahi badalti
cv/master.json                               CV ka data (sirf aap edit karein)
cv/default/abdulrehman_dar_resume.pdf        DEFAULT CV (asli PDF ki copy)
cv/versions/<stack>-v<N>/abdulrehman_dar_resume.pdf
cv/versions/custom-<company-role>/abdulrehman_dar_resume.pdf
```

- **Abhi har job pe default CV hi jata hai** (`config.json` mein `"autoCvVersions": false`).
- Kisi khaas job ke liye version chahiye ho to: `npm run bot -- prepare <id> --cv laravel`. `list` mein har job ke saath suggested version dikhta hai.
- Clusters: `laravel`, `tall`, `laravel-vue`, `mern`, `pern`, `next-nest`, `backend-node`, `frontend-react`, `ai-fullstack`.
- Jo version ek dafa ban jaye wo **reuse** hota hai. Naya `v2` sirf tab banta hai jab `master.json`, `src/cv/profiles.ts` ya template badle.
- Baad mein automatic versions chahiye hon to `"autoCvVersions": true` kar dein.
- PDF ka **naam har folder mein same** hai. Sirf folder ka naam batata hai ke ye kaun sa version hai.
- Har job ke saath DB mein likha hota hai ke kaun sa CV version gaya (`versions` command se usage dekhein).
- Profiles sirf re-frame karti hain (headline, summary, skills/bullets ka order). Koi nayi skill ya claim add nahi hota.
- CV mein kuch badalna ho to `cv/master.json` edit karein, phir `npm run bot -- cv:build` chalayein.
- Default CV `master.json` se banta hai. `master.json` edit karne ke baad `npm run bot -- cv:default` chalayein.
- Apni banai hui PDF use karni ho to use `cv/default/abdulrehman_dar_resume.pdf` pe rakh dein.

## Filters (`config.json` aur `src/match.ts`)

- **Location**: UAE, Saudi aur NL (onsite, visa ke saath), aur **Remote jobs jo Pakistan se ho sakein** (dashboard mein "🌍 Remote").
- **Remote** (`config.json` → `remote`):
  - "Worldwide", "Anywhere", "Pakistan", "Asia/APAC", "MENA" jaisi remote jobs aati hain.
  - "Remote — US only", "Canada", "LATAM", "must reside in the US" wali jobs skip hoti hain.
  - "EMEA" ya region na likha ho to warning aati hai ke Pakistan check kar lein.
  - Remote jobs pe visa ka check nahi lagta.
- **Role**: engineering titles hi lete hain. Doosre stacks (Java, Go, Python...), mobile, QA, management wagaira nikal dete hain.
- **Language**: "fluent Dutch/Arabic/German required" wali jobs skip hoti hain. "Arabic is a plus" pe sirf warning aati hai.
- **Visa**:
  - UAE/Saudi mein employer visa deta hai.
  - NL mein company ka **IND recognised sponsor** register pe hona zaroori hai, warna job skip.
  - "No sponsorship" ya "must have right to work" wali jobs skip.
- **Date**: `maxAgeDays` (abhi 14) se purani posting skip hoti hai. Har fetch pe dobara check hota hai, is liye matching job 14 din ki hote hi khud hat jati hai (prepared/applied wali nahi hatti).
- **Score**: aap ki skills ka job ki skills se weighted match. `minScore` config mein set hai.
- **Rules badle?** `config.json` edit karne ke baad `npm run bot -- rescore` chalayein. Ye bina download kiye saari jobs dobara check karta hai.

## Job sources

- **Company job boards** (`config.json` → `companies`, 50 companies): Greenhouse, Lever, Ashby, Recruitee, Workable aur SmartRecruiters.
- **Remote job boards** (`remote.boards`): Himalayas (sirf Pakistan ke liye open jobs), Remotive, RemoteOK.
- **Nayi company dhoondni ho:**

```bash
npm run bot -- discover careem talabat noon --add
```

  Bot har naam ko 6 job boards pe try karta hai. Jahan UAE/Saudi/NL ki jobs mile, `--add` use `config.json` mein daal deta hai. Mile nahi to naam ki doosri spelling try karein (`acme`, `acmeinc`, `acme-tech`).

## LinkedIn aur Bayt

- **LinkedIn** (`config.json` → `linkedin`):
  - Rozana ke fetch mein khud chalta hai. LinkedIn ka public (guest) job search use hota hai, login ke baghair, to aap ka account shamil nahi.
  - UAE, Saudi aur NL ki onsite jobs, aur `remoteFrom: "Pakistan"` ke saath remote jobs aati hain.
  - Requests ke beech 1.2 second ka wait hai, aur 429 (rate limit) milne pe us din LinkedIn chhod diya jata hai.
- **Bayt**:
  - Bot ki seedhi request block ho jati hai, is liye ye sirf Chrome ke andar se chalta hai: `scripts/bayt-collect.js`.
  - **Button:** dashboard → "Add jobs from Bayt" → **Bayt → Job Bot** button ko ek dafa bookmarks bar mein drag karein. Phir bayt.com pe wo bookmark click karein.
  - Page ke kone mein progress box aata hai. Jobs dashboard ke `/api/import` se bot mein jati hain.
  - Ya Claude ko kahein "Bayt se jobs add karo".
  - Pehli dafa Chrome "local network access" ki ijazat maangta hai, Allow karein.
  - Har page pe ~20 second lagte hain (~10 minute total), is liye Bayt rozana automatic nahi hai.

## AI (local Claude login, koi API key nahi)

AI features aap ke Mac pe signed-in Claude Code CLI (`claude -p`) se chalte hain (`config.json` → `ai`). Ye aap ke Claude plan ka usage istemal karte hain.

- **AI review / score:**
  - Har matching job ko CV ke saath parh kar 0–100 score deta hai: strong / good / stretch / poor.
  - Saath mein ek line ka mashwara, kyun fit hai, kya kami hai, aur red flags (part-time, language, visa, region-lock...).
  - Model: `haiku`, ~10 second fi job.
  - Rozana fetch ke baad nayi jobs ka review khud hota hai (har run mein `maxScorePerRun` tak).
  - Dashboard mein "AI review" button bhi hai. Terminal se: `npm run bot -- ai:score`.
  - Score box pe "AI" ya "kw" (keyword) likha hota hai. "Best match first" sorting mein AI score pehle aata hai.
- **Cover letter:**
  - "Prepare CV + letter" ab job description parh kar letter likhta hai (model: `sonnet`). Sirf CV ki sachi baatein use karta hai, aur aap ki taraf se timing, salary ya notice period ka koi wada nahi karta.
  - Job page pe "Rewrite letter" button hai.
  - AI fail ho to purana template letter ban jata hai. Template khud chahiye ho to `prepare <id> --template`.
- **Form answers:**
  - Job page → "Application form answers": form ke sawal copy karke box mein paste karein aur "Draft answers" dabayein (~15 second, model: `sonnet`).
  - Har jawab ke saath Copy button aur ek chhota mashwara (💡) hota hai. Yes/No aur choice wale sawalon ka jawab diye gaye options mein se hota hai.
  - Jawab sirf CV aur `cv/applicant.json` se bante hain. Salary, notice period, start date jaisi cheezein AI khud nahi bharta: wahan `[FILL: ...]` likha aata hai aur jawab peela (yellow) dikhta hai.
  - `cv/applicant.json` mein ye baatein ek dafa bhar dein (har country ki expected salary alag), phir agli dafa khud bhar jayengi.
  - Wahi sawal dobara poochein to purana jawab badal jata hai. "Clear all" se sab mit jate hain.
  - Terminal se: `npm run bot -- answer <id> --file questions.txt`

## Apply (aap khud karte hain)

**Bot kahin bhi khud apply nahi karta.** Apply aap karte hain. Bot ye madad karta hai:

- Dashboard → "Prepare CV + letter": CV (default ya `--cv` version) aur cover letter tayyar karta hai.
- Form ke sawal (salary, notice period, "why us"): job page pe "Draft answers" se jawab banwayein, check karein aur khud paste karein.
- Apply karne ke baad "Mark applied ✓" dabayein.
- Account banana, login aur CAPTCHA hamesha aap khud karte hain.

`add` ka JSON format:

```json
{ "source": "bayt", "company": "X", "title": "Senior Laravel Developer", "location": "Dubai, UAE",
  "url": "https://...", "description": "full job text" }
```

## Tests

```bash
npm test             # backend: matching, sources, dedupe, CV, AI, DB, CLI (node:test)
npm run test:web     # dashboard: components, DB queries, API routes, actions (vitest)
npm run test:all     # dono
```

- Tests alag databases pe chalte hain: backend `job_bot_test_bot`, dashboard `job_bot_test`. Asli `job_bot` ko kabhi nahi chhoote.
- Job sites ki requests mock hoti hain, aur Claude ki jagah ek fake script chalti hai. Is liye tests offline chalte hain aur aap ke Claude plan ka usage nahi hota.
- Har naye feature ya change ke saath us ke tests bhi likhe jaate hain (`CLAUDE.md`).

## Tech

- Node 24+ (TypeScript bina build ke chalta hai)
- PostgreSQL (`pg`) bot aur dashboard dono ke liye
- Next.js 16 + Tailwind (`web/`)
- `playwright-core` + system Chrome (CV ki PDF banane ke liye)
- Koi paid API nahi lagti
