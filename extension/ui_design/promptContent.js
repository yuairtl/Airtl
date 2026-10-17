// Author: Airtl yu
// Contact: yuairtl@outlook.com
'use strict';

// Release packages may contain editable placeholders. They are not instructions
// and must never count as a configured skill or overwrite existing user content.
function isPromptContent(value) {
  const text = String(value || '').replace(/^\uFEFF/, '').trim();
  return !!text && !/^需写入\s*prompts\s*$/i.test(text);
}

module.exports = { isPromptContent };
