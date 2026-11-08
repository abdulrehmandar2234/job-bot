// The CV designs: the bot's own list (src/cv/templates/list.ts, pure data, no renderers), so client components can
// import it. The bot renders them; the dashboard only names them.

export {
  DEFAULT_TEMPLATE,
  isTemplate,
  TEMPLATE_LIST as TEMPLATES,
  templateName,
  type TemplateId,
} from '../../src/cv/templates/list.ts';
