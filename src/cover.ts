import type { Job } from './db.ts';
import { config } from './config.ts';

const PITCH: Record<string, string> = {
  default: 'I work across both the JavaScript stack (NestJS, Next.js, React, Node.js, MongoDB) and PHP/Laravel, and I currently own the AI Screening and AI Interview modules at Qureos end to end.',
  laravel: 'Most of my career has been in PHP/Laravel, most recently delivering KYC onboarding, portfolio management and regulatory features for a regulated robo-advisory platform at Abyan Capital.',
  tall: 'Most of my career has been in Laravel, including Livewire, Alpine.js, Filament and Inertia.js, most recently on a regulated robo-advisory fintech platform at Abyan Capital.',
  'laravel-vue': 'I have built Laravel back ends with JavaScript front ends (Vue.js, Inertia.js, React) for fintech, marketplace and auction products.',
  mern: 'I have built MERN applications for international clients and now own the AI Screening and AI Interview modules at Qureos on NestJS, Next.js and MongoDB.',
  pern: 'I build TypeScript/Node.js services and React front ends on PostgreSQL and MongoDB, currently at Qureos on NestJS and Next.js.',
  'next-nest': 'I currently own the AI Screening and AI Interview modules at Qureos, built on NestJS and Next.js, from technical design through release.',
  'backend-node': 'At Qureos I build NestJS services, including LLM screening pipelines that process 5,000–10,000 candidates per request with quota-based cost controls.',
  'frontend-react': 'I build product front ends in React, Next.js and Redux, and I am comfortable down the stack in Node.js/NestJS and Laravel.',
  'ai-fullstack': 'At Qureos I own AI Screening and AI Interview: LLM-powered screening on OpenAI GPT APIs that ranks candidates, running 5,000–10,000 candidates per request with predictable per-candidate cost.',
};

export function coverLetter(job: Job): string {
  const country = job.country ? config.countries[job.country]?.name : null;
  const skills = job.matched.slice(0, 5).join(', ');
  return `Dear ${job.company} Hiring Team,

I am applying for the ${job.title} role. I am a Senior Full Stack Engineer with 7+ years of experience building and shipping production web applications. ${PITCH[job.cluster ?? 'default'] ?? PITCH.default}

Your posting asks for ${skills || 'a strong full stack engineer'}, which is the core of my day-to-day work. I own features end to end, from technical design and estimation to tests, code review and release, and I have mentored engineers in agile teams.

${job.country === 'RM'
    ? 'I am based in Lahore, Pakistan (GMT+5), have worked remotely with international clients and distributed teams, and am comfortable overlapping with European and Middle East working hours.'
    : `I am based in Lahore, Pakistan, and ready to relocate${country ? ` to ${country}` : ''}. I would need employer visa sponsorship and can start the process immediately.`}

Thank you for your time. I would welcome a conversation.

Best regards,
Abdul Rehman Dar
+92 321 4979646 | abdulrehmandar2234@gmail.com
https://www.linkedin.com/in/abdulrehman-dar/
`;
}
