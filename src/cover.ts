import type { Job } from './db.ts';
import { config } from './config.ts';
import { loadProfile, onsiteSituation, readMaster, signature, whereText } from './profile.ts';

// The template cover letter, used when the AI is off or fails (`prepare --template`). Everything personal comes from
// the profile (cv/applicant.json, name and contact from cv/master.json); sentences the profile lacks are left out.

const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');

/** "Senior Full Stack Engineer" -> "full stack engineer". */
const roleNoun = (title: string) => title.replace(/^((senior|junior|lead|staff|principal|sr\.?)\s+)+/i, '').toLowerCase();

const sentences = (...s: (string | null | undefined | false)[]) => s.filter(Boolean).join(' ');

export function coverLetter(job: Job): string {
  const p = loadProfile();
  const title = readMaster().title?.trim() || 'software engineer';
  const country = job.country ? config.countries[job.country]?.name : null;
  const skills = job.matched.slice(0, 5).join(', ');
  const intro = p.letter.intro ?? `I am ${article(title)} ${title}.`;
  const pitch = p.letter.pitch[job.cluster ?? 'default'] ?? p.letter.pitch.default;
  return `Dear ${job.company} Hiring Team,

${sentences(`I am applying for the ${job.title} role.`, intro, pitch)}

${sentences(`Your posting asks for ${skills || `a strong ${roleNoun(title)}`}, which is the core of my day-to-day work.`, p.letter.strengths)}

${situation(job, country)}

Thank you for your time. I would welcome a conversation.

${signature(p)}
`.replace(/\n{3,}/g, '\n\n');
}

/** Where the candidate is based, and relocation and visa for onsite jobs. */
function situation(job: Job, country: string | null | undefined): string {
  const p = loadProfile();
  const where = whereText(p);
  if (job.country === 'RM') {
    if (!where) return p.letter.remote ? `I ${p.letter.remote}.` : '';
    return `I am based in ${where}${p.letter.remote ? `, ${p.letter.remote}` : ''}.`;
  }
  const s = onsiteSituation(config, p, job.country);
  const to = country ? ` to ${country}` : '';
  const based = p.location ? `I am based in ${p.location}` : null;
  const first = s.relocate ? (based ? `${based}, and ready to relocate${to}.` : `I am ready to relocate${to}.`) : based && `${based}.`;
  const visa = s.visa
    ? 'I would need employer visa sponsorship and can start the process immediately.'
    : !s.home && country && `I can already work in ${country} without visa sponsorship.`;
  return sentences(first, visa);
}
