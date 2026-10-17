// Turn an incoming WhatsApp message into A2A message parts (text + optional file).

import { downloadMediaMessage, extractMessageContent, getContentType } from '@whiskeysockets/baileys'

const KINDS = {
  imageMessage: 'image',
  documentMessage: 'document',
  audioMessage: 'audio',
  videoMessage: 'video',
  stickerMessage: 'sticker',
}

// Small text-like files are inlined as text: every model can read them, and no file-part support is needed
const TEXT_LIKE = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-ndjson)\b)/
const MAX_INLINE_TEXT_BYTES = 200 * 1024

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
  'application/pdf': 'pdf',
}

// Unwraps ephemeral / view-once / document-with-caption wrappers and reports what the message holds
export function inspectMessage(msg) {
  const content = extractMessageContent(msg.message)
  if (!content) return { text: null, media: null }
  const type = getContentType(content)
  const node = content[type]
  const text = content.conversation || content.extendedTextMessage?.text || node?.caption || null
  const kind = KINDS[type]
  if (!kind) return { text, media: null }

  const mediaType = (node.mimetype || 'application/octet-stream').split(';')[0].trim()
  const filename = node.fileName || `${kind}-${msg.key.id}.${EXT[mediaType] || mediaType.split('/')[1] || 'bin'}`
  const size = Number(node.fileLength ?? 0)
  return { text, media: { kind, mediaType, filename, size, voiceNote: Boolean(node.ptt) } }
}

/**
 * Build A2A parts for a message. Returns { parts, notice } where notice is an optional
 * line to tell the WhatsApp user (e.g. "file too large, skipped").
 *  - inlineFiles: when false, binary files are described in text instead of attached
 */
export async function buildParts(sock, msg, info, { allowedKinds, maxBytes, inlineFiles, logger }) {
  const { text, media } = info
  const parts = []
  if (!media) return { parts: text ? [{ text }] : [], notice: null }

  const label = media.voiceNote ? 'voice note' : media.kind
  const header = text || `(The user sent ${/^[aeiou]/.test(label) ? "an" : "a"} ${label}: ${media.filename})`

  if (!allowedKinds.has(media.kind)) {
    return text ? { parts: [{ text }], notice: `Note: ${label} attachments aren't forwarded, only the caption was sent.` } : { parts: [], notice: null }
  }
  if (media.size && media.size > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(0)
    return { parts: text ? [{ text }] : [], notice: `That ${label} is larger than ${mb} MB, so it wasn't sent to the agent.` }
  }

  parts.push({ text: header })
  const textLike = TEXT_LIKE.test(media.mediaType)

  // Nothing to download if the file will only be described
  if (!textLike && !inlineFiles) {
    parts.push({ text: describeAttachment(media) })
    return { parts, notice: null }
  }

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  if (buffer.length > maxBytes) {
    return { parts: text ? [{ text }] : [], notice: `That ${label} is too large, so it wasn't sent to the agent.` }
  }

  if (textLike && buffer.length <= MAX_INLINE_TEXT_BYTES) {
    parts.push({ text: `Contents of ${media.filename}:\n\n${buffer.toString('utf8')}` })
    return { parts, notice: null }
  }

  if (!inlineFiles) {
    parts.push({ text: describeAttachment(media) })
    return { parts, notice: null }
  }

  // A2A 1.0 file part: bytes are base64 in JSON
  parts.push({ raw: buffer.toString('base64'), mediaType: media.mediaType, filename: media.filename })
  return { parts, notice: null }
}

export function describeAttachment(media) {
  const size = media.size ? `, ${Math.ceil(media.size / 1024)} KB` : ''
  return `[Attachment ${media.filename} (${media.mediaType}${size}) could not be delivered to you as a file.]`
}

export const hasFilePart = parts => parts.some(p => p.raw !== undefined)

// Replace binary file parts with a text note, keeping everything else
export function withoutFileParts(parts) {
  return parts.map(p => (p.raw === undefined ? p : {
    text: `[Attachment ${p.filename} (${p.mediaType}) could not be delivered to you as a file.]`,
  }))
}
