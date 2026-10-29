// One profile per stack cluster. A profile only re-frames what is already on the master CV:
// headline, summary emphasis, and the order of skills / experience bullets / projects.
// It must never add a skill, employer, number or claim that is not in cv/master.json.

export type Profile = {
  title: string;
  summary: string;
  skillsFirst: string[]; // these skills move to the front of their group
  groupsFirst: string[]; // these skill groups move to the top
  projectTags: string[]; // projects with these tags are listed first
  bulletKeywords: RegExp; // bullets matching this move up within each job
};

const YEARS = '7+ years';

export const PROFILES: Record<string, Profile> = {
  laravel: {
    title: 'Senior Laravel / PHP Engineer',
    summary: `Senior PHP/Laravel engineer with ${YEARS} of experience building scalable, secure web applications and APIs. Delivered KYC onboarding, portfolio management and regulatory compliance features for a regulated robo-advisory fintech platform in Laravel, and shipped Laravel products for international clients across marketplaces, ticketing and auctions. Strong in RESTful API design, MySQL/PostgreSQL performance tuning, caching, OAuth/JWT authentication and automated testing with Pest and PHPUnit. Also experienced across the JavaScript stack (Node.js, NestJS, React, Next.js), currently building LLM-powered features at Qureos.`,
    skillsFirst: ['PHP', 'Laravel', 'Eloquent', 'MySQL', 'PostgreSQL', 'Pest', 'PHPUnit', 'Livewire', 'Filament', 'Inertia.js'],
    groupsFirst: ['Languages & Runtimes', 'Frameworks & Libraries', 'Databases & ORMs', 'Testing & Practices'],
    projectTags: ['laravel', 'fintech'],
    bulletKeywords: /laravel|php|security|caching|query|oauth|jwt|kyc|compliance/i,
  },
  tall: {
    title: 'Senior Laravel Engineer (TALL: Tailwind / Alpine.js / Laravel / Livewire)',
    summary: `Senior Laravel engineer with ${YEARS} of experience building full-stack PHP applications with the TALL stack (Tailwind CSS, Alpine.js, Laravel, Livewire), Filament and Inertia.js. Delivered KYC onboarding, portfolio management and compliance features for a regulated robo-advisory fintech platform, plus marketplace, ticketing and auction products for international clients. Strong in Eloquent and MySQL/PostgreSQL optimisation, secure authentication, code review and automated testing with Pest and PHPUnit.`,
    skillsFirst: ['Laravel', 'Livewire', 'Alpine.js', 'Tailwind CSS', 'Filament', 'Inertia.js', 'PHP', 'Eloquent', 'MySQL', 'Pest'],
    groupsFirst: ['Frameworks & Libraries', 'Languages & Runtimes', 'Databases & ORMs', 'Testing & Practices'],
    projectTags: ['laravel', 'fintech'],
    bulletKeywords: /laravel|php|front-end|security|caching|query|kyc|compliance/i,
  },
  'laravel-vue': {
    title: 'Senior Full Stack Engineer (Laravel / Vue.js)',
    summary: `Senior full stack engineer with ${YEARS} of experience building web applications with PHP/Laravel back ends and JavaScript front ends including Vue.js, Inertia.js and React. Delivered KYC, portfolio management and compliance features for a regulated fintech platform in Laravel and shipped products for international clients. Strong in REST API design, database performance, secure authentication, testing and mentoring in agile teams.`,
    skillsFirst: ['Laravel', 'Vue.js', 'Inertia.js', 'PHP', 'JavaScript', 'TypeScript', 'MySQL', 'PostgreSQL'],
    groupsFirst: ['Frameworks & Libraries', 'Languages & Runtimes', 'Databases & ORMs'],
    projectTags: ['laravel', 'fintech'],
    bulletKeywords: /laravel|php|front-end|react|api|query/i,
  },
  mern: {
    title: 'Senior MERN Stack Engineer',
    summary: `Senior MERN stack engineer with ${YEARS} of experience building scalable web applications with MongoDB, Express.js, React and Node.js, plus NestJS and Next.js. Module owner of AI Screening and AI Interview at Qureos (NestJS, Next.js, MongoDB), running LLM screening pipelines over 5,000–10,000 candidates per request. Previously delivered marketplace, ticketing and auction products for international clients. Strong in REST and GraphQL APIs, MongoDB performance, testing with Jest and Mocha, code review and mentoring.`,
    skillsFirst: [
      'Node.js',
      'TypeScript',
      'JavaScript',
      'React.js',
      'Express.js',
      'Nest.js',
      'Next.js',
      'Redux',
      'MongoDB',
      'Mongoose',
      'Jest',
      'Mocha',
    ],
    groupsFirst: ['Languages & Runtimes', 'Frameworks & Libraries', 'Databases & ORMs', 'APIs & Web'],
    projectTags: ['mern', 'nest', 'ai'],
    bulletKeywords: /mern|node|react|mongo|nest|next|express|redux|pipeline/i,
  },
  pern: {
    title: 'Senior Full Stack Engineer (Node.js / React / PostgreSQL)',
    summary: `Senior full stack engineer with ${YEARS} of experience building TypeScript/Node.js back ends and React front ends on relational and document databases including PostgreSQL, MySQL and MongoDB, using Prisma, TypeORM and Sequelize. Currently owns AI Screening and AI Interview at Qureos on NestJS and Next.js, with LLM pipelines handling 5,000–10,000 candidates per request. Strong in REST and GraphQL API design, query optimisation, testing and code review.`,
    skillsFirst: ['TypeScript', 'Node.js', 'React.js', 'Express.js', 'Nest.js', 'Next.js', 'PostgreSQL', 'Prisma', 'TypeORM', 'Sequelize'],
    groupsFirst: ['Languages & Runtimes', 'Frameworks & Libraries', 'Databases & ORMs'],
    projectTags: ['nest', 'mern', 'ai'],
    bulletKeywords: /node|react|nest|next|database|query|pipeline/i,
  },
  'next-nest': {
    title: 'Senior Full Stack Engineer (NestJS / Next.js)',
    summary: `Senior full stack engineer with ${YEARS} of experience, currently module owner of AI Screening and AI Interview at Qureos — a recruitment platform built on NestJS, Next.js and MongoDB — owning features from technical design through release, including LLM screening pipelines that process 5,000–10,000 candidates per request. Strong TypeScript background across Node.js, NestJS, Express, React and Next.js, with REST and GraphQL APIs, PostgreSQL/MongoDB, testing, code review and mentoring. Also brings years of PHP/Laravel product experience.`,
    skillsFirst: [
      'TypeScript',
      'Node.js',
      'Nest.js',
      'Next.js',
      'React.js',
      'Express.js',
      'MongoDB',
      'PostgreSQL',
      'Prisma',
      'TypeORM',
      'Jest',
    ],
    groupsFirst: ['Languages & Runtimes', 'Frameworks & Libraries', 'Databases & ORMs', 'APIs & Web'],
    projectTags: ['nest', 'next', 'ai'],
    bulletKeywords: /nest|next|node|react|pipeline|llm|tests/i,
  },
  'backend-node': {
    title: 'Senior Backend Engineer (Node.js / NestJS)',
    summary: `Senior backend engineer with ${YEARS} of experience designing APIs and services in TypeScript/Node.js (NestJS, Express) and PHP/Laravel. At Qureos, built LLM screening pipelines on NestJS that process 5,000–10,000 candidates per request with quota-based cost controls. Strong in REST and GraphQL API design, MongoDB/PostgreSQL/MySQL performance tuning, OAuth/JWT security, automated testing and code review.`,
    skillsFirst: [
      'TypeScript',
      'Node.js',
      'Nest.js',
      'Express.js',
      'MongoDB',
      'PostgreSQL',
      'MySQL',
      'Prisma',
      'TypeORM',
      'GraphQL',
      'REST APIs',
    ],
    groupsFirst: ['Languages & Runtimes', 'APIs & Web', 'Databases & ORMs', 'Frameworks & Libraries'],
    projectTags: ['nest', 'ai'],
    bulletKeywords: /pipeline|back.end|server|api|database|query|security|oauth|jwt|nest|node/i,
  },
  'frontend-react': {
    title: 'Senior Frontend-focused Full Stack Engineer (React / Next.js)',
    summary: `Senior full stack engineer with ${YEARS} of experience and a strong front-end focus in React, Next.js, Redux and TypeScript, including the Next.js front end of Qureos' AI Screening and AI Interview modules. Built responsive, accessible interfaces for marketplaces and auction platforms, backed by solid API experience in Node.js/NestJS and Laravel, so I work comfortably across the whole product.`,
    skillsFirst: ['React.js', 'Next.js', 'Redux', 'Tailwind CSS', 'TypeScript', 'JavaScript', 'Vue.js', 'Inertia.js', 'Alpine.js'],
    groupsFirst: ['Frameworks & Libraries', 'Languages & Runtimes', 'Testing & Practices'],
    projectTags: ['next', 'mern'],
    bulletKeywords: /front-end|react|redux|next|interfaces|usability/i,
  },
  'ai-fullstack': {
    title: 'Senior Full Stack Engineer — LLM / AI Products',
    summary: `Senior full stack engineer with ${YEARS} of experience, currently building LLM-powered recruitment features at Qureos as module owner of AI Screening and AI Interview. Built candidate screening on OpenAI GPT APIs that ranks applicants against recruiter criteria, and pipelines that run 5,000–10,000 candidates per request with credit/quota controls to keep per-candidate LLM cost predictable. Hands-on with prompt engineering and AI agents, on top of a strong NestJS, Next.js, React, Node.js, MongoDB and Laravel background. Pursuing a Master's in Artificial Intelligence.`,
    skillsFirst: [
      'OpenAI GPT APIs',
      'LLM feature development',
      'AI Agents',
      'Prompt Engineering',
      'TypeScript',
      'Node.js',
      'Nest.js',
      'Next.js',
    ],
    groupsFirst: ['AI Tools & Agentic Development', 'Languages & Runtimes', 'Frameworks & Libraries'],
    projectTags: ['ai', 'nest'],
    bulletKeywords: /llm|gpt|ai |screening|pipeline|cost/i,
  },
};
