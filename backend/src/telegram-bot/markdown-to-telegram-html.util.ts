// Минимальный конвертер Markdown в HTML-подмножество, которое реально понимает Telegram
// Bot API (parse_mode=HTML): <b>, <i>, <s>, <code>, <pre>, <a href>. Никаких заголовков,
// таблиц, списков и т.п. — Telegram их не поддерживает, а автор постов (TelegramBotPage.tsx,
// «Новости»/«Инструкции») и так пишет короткие объявления, а не документы. Своя реализация,
// а не сторонняя markdown-библиотека — Telegram поддерживает не HTML вообще, а конкретный
// маленький список тегов без атрибутов (кроме href у <a>), полноценный HTML-рендер markdown
// пришлось бы всё равно урезать до того же подмножества постобработкой.
//
// Порядок важен: сначала экранируем HTML-спецсимволы (иначе admin, случайно написавший "<"
// в тексте, сломает разметку или получит ошибку от Telegram API), затем прячем код
// (блоки/инлайн) за плейсхолдерами до применения bold/italic — иначе "*" внутри `code`
// тоже превратится в <i>. Плейсхолдеры вида " CB0 "/" IC0 " — коллизия с реальным текстом
// поста практически исключена (нужно набрать именно такую подстроку с пробелами по краям).
export function markdownToTelegramHtml(markdown: string): string {
  let text = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const codeBlocks: string[] = [];
  text = text.replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(`<pre>${code}</pre>`);
    return ` CB${codeBlocks.length - 1} `;
  });

  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`<code>${code}</code>`);
    return ` IC${inlineCodes.length - 1} `;
  });

  // Ссылки — до bold/italic, чтобы "_"/"*" внутри URL не путались с разметкой.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // Одиночная "*"/"_" — курсив (уже обработанный **bold** сюда не попадёт — он выше
  // превратился в <b>, "**" в тексте больше не осталось).
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<i>$1</i>');

  text = text.replace(/ IC(\d+) /g, (_match, i: string) => inlineCodes[Number(i)]);
  text = text.replace(/ CB(\d+) /g, (_match, i: string) => codeBlocks[Number(i)]);

  return text.trim();
}
