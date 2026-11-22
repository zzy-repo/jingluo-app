import type { zh } from './zh.js'

export const en = {
  welcomeMessageChat250808: 'How can I help you?',
  contentCaveat: 'AI-generated, for reference only',
  modeSwitchLabel: 'Chat mode',
  modeFast: 'Fast mode',
  modeExpert: 'Expert mode',
  expandSiderbarButton: 'Open sidebar',
  collapseSiderbarButton: 'Close sidebar',
  newChat: 'New chat',
  untitledChat: 'New chat',
  sessionLoading: 'Loading chats...',
  sessionListLoadFailed: 'Unable to load the chat list. Please try again.',
  sessionLoadFailed: 'Unable to load this chat. Please try again.',
  sessionSaveFailed:
    'Chats or attachments have not been saved locally. Retry before closing this page.',
  sessionDeleteFailed: 'Unable to delete this chat. Please try again.',
  settings: 'Settings',
  appName: '鲸落',
  deleteSessionModalContentTitle: 'Delete chat?',
  deleteSessionWithFilesDescription:
    'This chat and its uploaded files will be permanently deleted and cannot be recovered. Delete this chat?',
  cancel: 'Cancel',
  back: 'Back',
  delete: 'Delete',
  sessionItemMenuRenameOption: 'Rename',
  sessionItemMenuPinOption: 'Pin chat',
  sessionItemMenuUnpinOption: 'Unpin chat',
  sessionPinnedLabel: 'Pinned',
  sessionPinnedGroup: 'Pinned chats',
  more: 'More',
  close: 'Close',
  sessionHistoryTimelineLabelToday: 'Today',
  sessionHistoryTimelineLabelYesterday: 'Yesterday',
  sessionHistoryTimelineLabel7days: '7 Days',
  sessionHistoryTimelineLabel30days: '30 Days',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed. Please long-press or select the text to copy.',
  copyTooLargeTitle: 'Content too long to copy',
  copyTooLargeBody:
    'This content is about {size} KiB, past the {limit} KiB the clipboard handles reliably. Copying would truncate or silently fail — save it as a TXT file instead.',
  copyTooLargeSave: 'Save as TXT',
  copySaveFailed: 'Save failed. Try again or long-press to select and copy the text.',
  send: 'Send',
  scrollToBottom: 'Back to bottom',
  scrollToBottomHasNew: 'Back to bottom (new content)',
  editMessage: 'Edit message',
  regenerate: 'Regenerate',
  continueGenerating: 'Continue',
  changeApiKey: 'Change API Key',
  /** "Open settings" entry inside the error notice (#347 / #353) */
  openSettingsEntry: 'Open settings',
  topUp: 'Top up',
  messageSearchSummary: '1 web page',
  messageSearchSummaries: '{count} web pages',
  messageVersions: 'Message versions',
  previousVersion: 'Previous version',
  nextVersion: 'Next version',
  searchResult: 'Search results',
  mermaidDiagram: 'Diagram',
  mermaidCode: 'Code',
  mermaidEmpty: 'This diagram is empty.',
  mermaidLoading: 'Rendering diagram...',
  mermaidRenderFail: 'Mermaid rendering failed.',
  mermaidSwitchLabel: 'Toggle between Mermaid diagram and code',
  /** Language row actions of a code block: line numbers / wrap / download (#486 P0-1, P0-4) */
  codeLineNumbers: 'Lines',
  codeWrap: 'Wrap',
  codeDownload: 'Download code',
  codeDownloadSaved: 'Saved',
  codeDownloadFailed: 'Save failed. Please try again.',
  /** Copy-the-whole-table action above a table; the clipboard gets standard GFM (#486 P0-3) */
  tableCopy: 'Copy table',
  /** Copy-the-source action on a formula; reads pure TeX from the katex-mathml annotation (#486 P0-2) */
  mathCopySource: 'Copy TeX source',
  /** #821: bubble-style prompts use macros KaTeX lacks (\scalebox …); failed modules degrade to this */
  mathUnsupportedBlock: 'This line uses unsupported typesetting commands',
  /** #821: reveal the module's raw TeX inside the collapsible */
  mathSourceToggle: 'Show source',
  /** #821: explain what KaTeX reported inside the collapsible */
  mathUnsupportedReason: 'Reason: ',
  /** #821: one-line notice when option-A equivalence mapping dropped scaling / rotation */
  mathSimplified: 'Some typesetting commands were simplified',
  /** #821: this block did not error out, but KaTeX printed the arguments as text (`[0pt][0pt]`) */
  mathIgnoredArgs: 'Typesetting arguments were ignored — KaTeX may not support this form',
  toolSearchIntro: 'Searching for',
  messageSearching: 'Searching...',
  imageSearching: 'Searching by image...',
  searchStopped: 'Search stopped',
  toolSearchFail: 'Search currently unavailable',
  toolSearchNoResult: 'No suitable results found',
  messageSearchNoResult: 'No relevant results found',
  toolSearch1Result: 'Found 1 web page',
  toolSearchResults: 'Found {count} web pages',
  messageSearchResult: 'Read 1 web page',
  messageSearchResults: 'Read {count} web pages',
  toolOpenOneIntro: 'Read 1 page',
  toolOpensIntro: 'Read {count} pages',
  toolOpenFail: 'Read failed',
  toolOpenFailTooltip: 'Read failed',
  toolOpenViewAll: 'View All',
  toolFindFail: 'Find failed',
  toolFindIntro: 'Find keyword',
  toolFindFailTooltip: 'No related content found',
  readingLink: 'Reading',
  commonNetworkErrorToast: 'Network Error. Please check your network status.',
  /**
   * Key rejected (#374): previously the only sentence for every 401. It is now the
   * fallback for "the upstream rejected the key without saying why"; the specific
   * cases have their own keys below (replyApiKey*).
   */
  replyInvalidApiKey:
    'The upstream rejected this API Key without saying why (it may be invalid, expired, or not belong to this endpoint).',
  /** Key format problem (#374): detectable locally, the request never left the app */
  replyApiKeyFormatWrong:
    'The API Key you entered is malformed (it contains spaces or line breaks, or is not key-length), so the request was never sent.',
  /** Key does not exist / was deleted on the server (#374) */
  replyApiKeyNotFound:
    'This API Key is invalid or has been deleted (the upstream cannot find it: it was never bound, or the server deleted it).',
  /**
   * Key rotated / revoked (#374's `rotated` case).
   *
   * #451 alignment with #357: "Reset quota" in settings (`/rotate`) does NOT change the key,
   * it only recomputes the quota — so this invalidation did not come from that button; the
   * server invalidated the old key. The old wording ("rotating a key invalidates the old key
   * immediately") is the pre-#357 story and made users think the reset button broke their key.
   */
  replyApiKeyRotated:
    'This API Key has been rotated or revoked and the old one no longer works. (Resetting the quota on this device only recomputes it and keeps the same key, so the server is what invalidated it.) You can recover the current key from the server by device code under The built-in channel, or simply paste a new key.',
  /** Key identity in the notice: last 4 characters only (#374) */
  replyApiKeyTailNote: ' (current key ends with {tail})',
  /**
   * Warning shown before changing a key (#374): users fear losing their quota,
   * so the copy says the quota belongs to the account and to check it first.
   */
  replyApiKeyQuotaNote:
    'Changing the API Key affects which account the quota belongs to; check the current account in the quota panel before switching.',
  /** "Check quota" entry inside the key notice (#374): opens the quota panel without touching the key */
  openQuotaPanel: 'Check quota',
  replyInsufficientBalance:
    'Insufficient balance or quota. Cannot continue generating (do not retry; top up first).',
  /** Top-up entry inside the quota notice (#299): reuses the quota & card dialog */
  quotaTopUpEntry: 'Top up / Redeem a card',
  /**
   * Rate limit (#347: the status code now shows): 429 is a **retryable** temporary failure,
   * and this copy must stay distinguishable from the terminal "do not retry" errors.
   */
  replyRateLimited:
    'Too many requests (HTTP 429, temporary rate limit, retryable). Please try again later.',
  completionServerBusyToast: 'Server busy, please try again later.',
  /** Server-busy error in a reply (#324): states explicitly that retrying may work */
  replyServerBusy:
    'Server busy — a temporary failure, the reply did not finish. You can retry (tap regenerate).',
  replyUnknownError: 'The reply did not finish due to an unknown error. Please regenerate.',
  /** Context over the model limit (#122): retrying will not help, offer two ways out */
  replyContextLimit:
    'This conversation is over the model’s context limit, so the request was not sent. Start a new session to continue, or delete a few older messages and try again.',
  /**
   * Network unreachable / DNS / CORS (#771 case 2): the request never reached the upstream.
   * Say explicitly that the upstream is NOT slow — users mistake a local network problem
   * for a slow model and keep regenerating while nothing can change.
   */
  replyNetworkUnreachable:
    'The request never left the app (offline, DNS failure, or blocked by CORS) — the upstream is not slow. Check your network or proxy, then tap “regenerate”.',
  replyStreamInterrupted:
    'The connection was interrupted and the reply is incomplete. What was received is kept — a temporary failure, you can retry (tap regenerate).',
  /** Empty stream (#324): the upstream returned 200 but no content at all */
  replyEmptyStream:
    'The upstream returned no content this time (empty response). A temporary failure — you can retry (tap regenerate).',
  /** Content safety block (#324): resending the same text will be blocked again */
  replyContentFiltered:
    'This content was blocked by the upstream safety review. Rephrase it or remove the sensitive part; do not retry the same text — it will be blocked again.',
  /**
   * Model missing / retired (#324 / #339): name the model that was actually sent plus the
   * upstream's list. Built-in channels have no model row in settings, so point at upgrading.
   */
  replyModelInvalid:
    'The current model “{model}” is unavailable upstream (its name may have been retired). Models available upstream: {models}. The DeepSeek Official channel uses a built-in model and has no row for it in settings — upgrading to the fixed version is enough; on other channels, pick another model in settings. Retrying the same request will not help (do not retry).',
  /** Upstream did not list usable models (#339) */
  replyModelInvalidNoModels: 'not listed by the upstream',
  /** The reply did not record a model name (imported history, #339) */
  replyModelUnknownName: 'not recorded',
  /** Other rejected requests (#347): 400 / 422 where the upstream named no field */
  replyBadRequest:
    'Invalid request parameters ({status}): the upstream refused this request (not a network problem, not an outage on our side). Retrying will not help — check the model and endpoint settings (do not retry).',
  /** Invalid field, and the upstream named which one (#347 / #353) */
  replyParamInvalid:
    'Invalid request parameters ({status}): the upstream rejected the field “{field}” — this request was refused upstream (not a network problem, not an outage on our side). Retrying will not help (do not retry).',
  /** Other rejected 4xx (#347): 403 / 404 / 405 / 409 / 415 — no guessing at the cause */
  replyUpstreamRejected:
    'The upstream rejected this request ({status}): retrying will not help (do not retry). Expand the upstream message below to see why, or tap “Copy diagnostics” and send it to us.',
  /** Placeholder used when a stream error frame carries no HTTP status (#347) */
  replyUpstreamStatusUnknown: 'no status from the upstream',
  /** Collapsible toggle: collapsed by default, the upstream text is opt-in (#347 / #353) */
  upstreamDetailToggle: 'Show upstream details',
  /** Unclassified but self-evident (status / upstream code present) (#324) */
  replyUnclassifiedRetryable:
    'The reply did not finish: {detail}. A temporary failure — you can retry (tap regenerate).',
  replyUnclassifiedFatal:
    'The reply did not finish: {detail}. Retrying will not help (do not retry) — check settings first, or send us “Copy diagnostics”.',
  replyWaitingFirstToken: 'Waiting for the response',
  replyWaitingSlow: 'The service is responding slowly. Still waiting…',
  replyWaitingStalled: 'This is taking unusually long. You can stop and regenerate.',
  /** Staged timeouts (#568): one line per stage, so the user can tell where it hung */
  replyIdleTimeout:
    'Taking too long: no new content for {seconds}s. You can stop and regenerate.',
  replyFirstTokenTimeout:
    'Connected upstream, but no first token within {seconds}s (the upstream may be queueing or overloaded). Tap “regenerate” to send it again, or try later.',
  /** Stage names before the first token (#328); the seconds come from waitElapsed, never hardcoded */
  waitStagePreparing: 'Preparing the request',
  waitStageUploading: 'Uploading attachments',
  waitStageConnecting: 'Connecting upstream, waiting for a response',
  waitStageAwaitingFirstToken: 'Connected, waiting for the first token',
  waitStageThinking: 'The model is thinking',
  waitElapsed: '{seconds}s elapsed',
  /** Auto-retry progress: a failed request never hangs silently (#105) */
  chatRetrying: 'Retrying (attempt {attempt} of {limit})',
  replyRefused: "Sorry, that's beyond my current scope. Let's talk about something else.",
  messageThinkDuration: 'Thought for {count} second',
  messageThinkDurationPlural: 'Thought for {count} seconds',
  messageThinkStopped: 'Stopped',
  deepSearchSearching: 'Searching the web',
  groupTitleToolOpen: 'Browsing the web',
  messageThinking: 'Thinking',
  backupInvalidJson: 'The file is not valid JSON.',
  backupUnrecognized: 'File not recognized. Please choose a DeepSeek chat history ZIP.',
  backupNewerVersion: 'This file uses a newer version. Please update the app before importing.',
  backupInvalidVersion: 'The file version is invalid and cannot be imported.',
  backupIncomplete: 'The file is incomplete and cannot be imported.',
  backupInvalidBranches: 'The message branches in this file are corrupted and cannot be imported.',
  backupInvalidFiles: 'The attachment data in this file is corrupted and cannot be imported.',
  backupManifestNotFirst: 'The first entry in this ZIP is "{found}", but "{expected}" must come first. Choose the original DeepSeek export ZIP instead of a repacked folder.',
  backupEmptyArchive: 'This ZIP contains no files. Please choose a DeepSeek chat history ZIP.',
  backupArchiveDamaged: 'This ZIP is damaged: entry #{index} ("{entry}") failed validation, so the file may be truncated or repacked by another tool.',
  backupArchiveUnreadable: 'This ZIP is damaged: its file directory cannot be read, so the file may be truncated or repacked by another tool.',
  backupEntryOutOfOrder: 'Entry #{index} ("{entry}") comes after the session "{session}" but is not inside that session image folder, and the session index has not been read yet, so its session cannot be determined. Choose the original DeepSeek export ZIP instead of a repacked or reordered one.',
  backupEntryUnreferenced: 'Entry #{index} ("{entry}") is neither a session file nor inside any imported session image folder. The ZIP may have been repacked or renamed; choose the original DeepSeek export ZIP.',
  settingsLocalePreference: 'Language',
  settingsTtsVoice: 'Read-aloud voice',
  settingsTtsVoiceStella: 'Stella (female)',
  settingsTtsVoiceTide: 'Tide (male)',
  settingsLocation: 'Location',
  settingsLocationProvince: 'Select province/region',
  settingsLocationCity: 'Select city',
  settingsLocationRegion: 'Select country or region',
  settingDialogAsideGeneralOptionLabel: 'General',
  settingDialogAsideDataOptionLabel: 'Data',
  avatarMenuSettingsDialogThemeItemLabel: 'Theme',
  avatarMenuSettingsDialogThemeSelectLightOption: 'Light',
  avatarMenuSettingsDialogThemeSelectDarkOption: 'Dark',
  avatarMenuSettingsDialogThemeSelectSystemOption: 'System',
  apiKeyStart: 'Enter an API Key to get started',
  apiKeyEdit: 'Edit API Key',
  apiKeyPlaceholder: 'Enter API Key',
  apiKeyVerifying: 'Verifying...',
  confirm: 'Confirm',
  apiKeyInvalid: 'Invalid API Key. Please check it and try again.',
  apiKeyVerificationFailed: 'Verification failed: {message}',
  historyImport: 'Import chat history',
  historyImportConfirm: 'Import',
  historyImportConfirmTitle: 'Import chat history?',
  historyImportConfirmDescription:
    'Choose how to import: merge keeps your local chats, replace all clears every local chat.',
  historyImportDescription:
    'Choose how to import (merge / skip existing / replace all). Supports ZIP files exported from DeepSeek.',
  historyImportModeLabel: 'Import mode',
  historyImportModeMerge: 'Merge (recommended)',
  historyImportModeMergeHint:
    'Keeps every local chat; for the same chat the newer version wins by update time',
  historyImportModeSkip: 'Skip existing',
  historyImportModeSkipHint: 'Keeps local chats that already exist and only adds new ones',
  historyImportModeOverwrite: 'Replace all',
  historyImportModeOverwriteHint:
    'Clears the {count} local chats and their attachments before importing (restores a backup)',
  historyImportOverwriteAcknowledge: 'I understand the {count} local chats will be cleared',
  historyImportConfirmOverwrite: 'Replace and import',
  historyImportConflictRule:
    'A chat is identified by its session ID only: the same ID means the same chat; the same title with a different ID is a different chat.',
  historyImportSummaryDetail: ' (added {added} / replaced {overwritten} / skipped {skipped})',
  historyImportConflictSkippedTitle: 'Chats where the local version was kept (same ID, newer locally)',
  historyExportEmptySelection: 'No chats selected — nothing to export',
  historyExportSelectedCount: '{count} selected',
  historyExportSelectedEmpty: 'Select at least one chat to export',
  historySelectModeEnter: 'Select',
  historySelectModeExit: 'Exit selection',
  historySelectAll: 'Select all',
  historySelectInvert: 'Invert',
  historyExportSelected: 'Export selected',
  historyExportSelectedSaved: 'Exported {count} chats — file: {name}',
  historyImportedOne: 'Imported 1 chat',
  historyImported: 'Imported {count} chats',
  historyImportFromUrl: 'Import from link',
  historyImportUrlStart: 'Import link',
  historyImportUrlDescription:
    'Paste the DeepSeek export ZIP link; the app downloads it directly (Android app only).',
  historyImportUrlPlaceholder: 'https://…/deepseek_data.zip',
  historyImportUrlDownloadingProgress: 'Downloading… {done}/{total} ({percent}%)',
  historyImportUrlDownloadingBytes: 'Downloading… {done} downloaded',
  historyImportUrlDecoding: 'Parsing…',
  historyImportUrlImporting: 'Importing… {processed}/{total} chats',
  historyImportUrlImportingCount: 'Importing… {processed} chats processed',
  historyImportUrlExpired:
    'The download link has expired. Export your history again from DeepSeek and retry.',
  historyImportUrlBadSignature: 'Invalid link (signature mismatch). Copy the full link again.',
  historyImportUrlForbidden: 'No access to this link (403): {detail}',
  historyImportUrlOffline: 'Network disconnected. Check your connection and retry.',
  historyImportUrlRefused:
    'Connection refused: the server did not accept the connection (service down or blocked by a firewall). Try again later.',
  historyImportUrlInterrupted:
    'Connection dropped ({percent}% downloaded). Check your network and retry.',
  historyImportUrlTimeoutPartial:
    'Download timed out ({percent}% downloaded). Try a faster network.',
  historyImportUrlStalled:
    'Download stalled: no new data for {seconds}s ({done} / {total} downloaded). Retry to continue.',
  historyImportUrlStalledUnknownTotal:
    'Download stalled: no new data for {seconds}s ({done} downloaded). Retry to continue.',
  historyImportUrlDeadline:
    'Download timed out: over the {minutes}min cap ({done} / {total} downloaded). Retry to continue.',
  historyImportUrlDeadlineUnknownTotal:
    'Download timed out: over the {minutes}min cap ({done} downloaded). Retry to continue.',
  historyImportUrlRestarted:
    'This link does not support resuming, so the download restarted from the beginning.',
  historyImportUrlResumed: 'Resumed from where the last attempt stopped ({done} downloaded).',
  historyImportCancelled: 'Import cancelled',
  importTraceTitle: 'Import details ({count})',
  importTraceCopy: 'Copy details',
  importTraceElapsed: 'Took {time}',
  importTraceStart: 'Import started',
  importTraceDownload: 'Downloaded {done}',
  importTraceDownloadTotal: 'Downloaded {done} / {total}',
  importTraceCheck: 'Archive validated, {total} chats found',
  importTraceCheckUnknown: 'Validating archive…',
  importTraceSession: 'Importing chats {done}/{total}',
  importTraceSessionUnknown: 'Importing chats ({done})',
  importTraceImage: 'Images written: {count}',
  importTraceDone: 'Done, {count} chats',
  importTraceCancel: 'Cancelled',
  importTraceError: 'Failed ({stage}): {reason}',
  importTraceStageDownload: 'download',
  importTraceReasonUnreachable: 'network unreachable',
  importTraceReasonInterrupted: 'connection interrupted',
  importTraceReasonTimeout: 'download timed out',
  importTraceReasonNetwork: 'network error',
  importTraceReasonExpired: 'link expired',
  importTraceReasonSignature: 'signature mismatch',
  importTraceReasonForbidden: 'no permission (403)',
  importTraceReasonHttp: 'HTTP {status}',
  importTraceReasonStalled: 'stalled (no new data for {seconds}s, {done} downloaded)',
  importTraceReasonDeadline: 'download timed out (over the {minutes}min cap)',
  importTraceHeartbeat: 'still downloading… ({done} / {total}, no new data for {idle}s)',
  importTraceHeartbeatUnknown: 'still downloading… ({done}, no new data for {idle}s)',
  importTraceResume: 'resumed from {done} (not from zero)',
  importTraceRestart: 'link does not support resuming; restarted from the beginning',
  detailsExpand: 'Show more',
  detailsCollapse: 'Show less',
  historyImportUrlDownloading: 'Downloading...',
  historyImportUrlDownloadingHint:
    'Downloading and importing. A ~20MB export can take tens of seconds; please keep this screen open.',
  historyImportFromUrlFailed: 'Import from link failed: {message}',
  historyImportUrlInvalid: 'Enter a link starting with http:// or https://',
  historyImportUrlNativeOnly:
    'Link import is unavailable on the web. Download the ZIP and upload it.',
  historyImportUrlNetwork: 'Download failed. Check your network connection and try again.',
  historyImportUrlTimeout: 'Download timed out. Check your network and try again.',
  historyImportUrlHttp:
    'The link returned an error status (HTTP {status}). Check that it is still valid.',
  historyImportUrlTooLarge: 'The file is {actual}, over the {size}MB import limit, so it was not imported.',
  historyImportUrlNotZip:
    'Not a valid ZIP file. Check that the link points to a DeepSeek chat history export.',
  historyImportUrlBadResponse: 'The download response could not be parsed. Please try again.',
  historyImportUrlWebHint:
    'The web app cannot download export links directly. Download the ZIP and upload it.',
  historyImportFailed:
    'File import failed. The file format may be invalid, or the ZIP file may use an older chat export format. Please export your chat history from DeepSeek again and retry the import.',
  historyExportFailed: 'Export failed: {message}',
  historyExportSaved: 'Saved to the location you chose: {name}',
  historyExportFailedStart: 'Export failed: could not open the save location. Please try again.',
  historyExportFailedWrite: 'Export failed: could not write the file. Check free storage and try again.',
  historyExportFailedTooLarge:
    'Export failed: the archive exceeds the 200MB export limit (same as the import limit). Delete some chats and try again.',
  historyExportTooLarge:
    'This history is about {actual}, over the {size}MB export limit. Delete chats you no longer need, or remove large images from messages, and try again.',
  historyExporting: 'Exporting…',
  historyExportProgress: 'Exported {exported} of {total} chats',
  historyExportEmptyNoSessions: 'There are no chats to export yet.',
  exportAllLabel: 'Export all chats',
  historyExportDescription:
    'Includes all chat history and locally stored images. Other attachments retain file details only. Your API Key is not included.',
  exportAllDownload: 'Download',
  deleteAllSessions: 'Delete all chats',
  deleteAllSessionsModalTitle: 'Once deleted, all chats will be cleared and cannot be recovered.',
  deleteAllSessionsModalDescription:
    'Locally saved attachments and unsent drafts will also be deleted.',
  historyDeleting: 'Deleting...',
  historyDeleted: 'Successfully deleted.',
  historyDeleteFailed: 'Failed to delete chats. Please try again.',
  upload: 'Upload',
  uploadUnsupportedFormat:
    'The selected files include unsupported formats. Please convert them and try again. Supported: PDF, DOC, XLSX, PPT, images, text, code, and more.',
  uploadFileStatusFailed: 'Upload failed',
  uploadFailedSourceMissing:
    '"{name}" has no local copy left (imported conversations keep file details only), so it was skipped',
  uploadFailedEndpointMissing: 'Failed to upload "{name}": this channel has no upload endpoint (404)',
  uploadFailedTooLarge: 'Failed to upload "{name}": the file is over the size limit',
  uploadFailedNetwork: 'Failed to upload "{name}": network error. Please retry',
  uploadFailedUnknown: 'Failed to upload "{name}"',
  attachUnavailableSent:
    '{names} unavailable on this device (imported conversations keep file details only). This message was sent as text.',
  attachUnavailableNoText:
    'The attachments are unavailable on this device and this message has no text, so nothing was sent',
  uploadChannelUnsupported: 'This channel does not support file uploads',
  uploadRetry: '{message}. Click to retry',
  chatInputPlaceholderChat: 'Enter a message',
  deactivatedThinkTooltip: 'Think before responding to solve reasoning problems',
  thinkingSwitch: 'DeepThink',
  deactivatedSearchTooltip: 'Search the web when necessary',
  search: 'Search',
  uploadFile: 'Upload files',
  chatInputStopButtonTooltip: 'Stop',
  uploadMaxMBSize: 'File exceeds the size limit ({size} MB). Please adjust and try again.',
  uploadMaxFiles: 'You can upload up to {count} files',
  uploadFileStatusUploading: 'Uploading...',
  uploadServerBusy: 'Server busy',
  uploadParseFailed: 'Parsing failed',
  /** `{formats}` 由白名单派生（见 zh.ts 同 key 的注释 / #580） */
  imageUnsupportedFormat:
    'Unsupported image format: only {formats} are accepted (convert HEIC to JPEG first).',
  imageDecodeFailed: 'This image cannot be opened. Try another file, or convert it to PNG / JPEG.',
  imageTooLarge: 'The image is still over {size} MB after compression. Compress or crop it first.',
  imageAnimatedTooLarge:
    'This animated image is over {size} MB or too large; compressing it would flatten the animation. Please compress it first.',
  imageEncodeFailed: 'Failed to encode the image. Please retry or use another file.',
  imageSourceMissing:
    'The local copy of this image is gone, so it cannot be sent. Please add it again.',
  imageTooMany: 'A message can include at most {count} images.',
  imagePreviewOpen: 'View full size',
  imageTotalTooLarge: 'Images in this message exceed {size} MB in total. Please send fewer images.',
  uploadImageOnly: 'This channel can only send images. Switch to a supported channel for documents.',
  visionUnsupported: 'This channel does not support images. Switch to a channel or model that does.',
  uploadFileCountLimit: 'Uploaded file limit reached ({limit} files). ',
  uploadStorageLimit: 'Uploaded file storage limit reached ({limit} GB). ',
  uploadDeleteFiles: 'Delete files',
  dragFileToUpload: 'Drop files here to upload',
  dragFileDesc: 'Up to {count} files, {size} MB each',
  voiceInput: 'Voice input',
  voiceInputTimer: 'Recording {seconds}s',
  voiceInputStop: 'Stop recording and transcribe',
  voiceInputCancel: 'Transcribing. Click to cancel',
  voiceInputPermissionDenied:
    'Microphone access is blocked. Please allow it in your browser settings.',
  voiceInputNoDevice: 'No microphone detected',
  voiceInputFailed: 'Speech recognition failed. Please try again later.',
  voiceInputEmpty: 'No speech detected',
  voiceInputLimitReached: 'Maximum recording length reached',
  voiceInputRequiresHttps: 'Voice input requires HTTPS',
  /** #451: state the diagnosis and both ways out — paste another key, or recover this device's key */
  apiKeyInvalidRetry:
    'Invalid API Key. Paste it again, or recover this device key with "Reset quota" under The built-in channel.',
  apiKeyRejected: 'The API key is invalid or expired. Please log in again or re-enter it.',
  /**
   * #596 / #800: there is nothing to re-enter on our channel — the only way out is for the server to
   * issue the key again. Since #800 that recovery is automatic (alignment on start and after sign-in,
   * plus one more attempt in Settings when a send is blocked), so the copy no longer points at the
   * removed "Re-claim" button.
   */
  apiKeyRejectedOurs:
    'The built-in service key is no longer valid. The app re-aligns it with the server automatically — retry in a moment (reopening the app also triggers an alignment).',
  insufficientBalance: 'Insufficient balance',
  rateLimited: 'Too many requests. Please try again later.',
  ttsPlay: 'Read aloud',
  ttsStop: 'Stop reading',
  ttsUnavailable: 'This answer cannot be read aloud right now',
  ttsFailed: 'Failed to read aloud. Please try again later.',
  retry: 'Retry',
  latestReminderLanguage: 'English',
  settingsLocaleZhCN: 'Simplified Chinese',
  settingsLocaleEnUS: 'English',

  // ---------- Service config (channel / API Key / service URL / model) ----------
  settingsProviderKindLabel: 'Channel',
  settingsProviderKindKeyHint: 'Check that your API Key still applies after switching channels',
  settingsApiKeyLabel: 'API Key',
  /**
   * Pre-send local block (#451): the key exists but is clearly malformed, so the message was
   * NOT sent. Saying so explicitly matters — otherwise people keep retrying and blame the network.
   */
  settingsApiKeyFormatBlocked:
    'The saved API Key looks malformed (it contains spaces or line breaks, or is not key-length), so this message was not sent. Clear the field, paste the whole key again (no spaces or line breaks), then send.',
  /** A suspicious key is stored but no send has been attempted yet: keep it calm, no red text */
  settingsApiKeyFormatHint:
    'This value does not look like an API Key (stray spaces or line breaks, or an incomplete paste). Sending will be blocked until it is fixed.',
  /**
   * #596: the Our-channel API key is issued by the server — this row is read-only (current tail)
   * plus "Re-claim"; there is no input. Never phrase this as "server busy" / "unknown error":
   * accident #1 in #596 was a stale local key 401-ing while the user was told the server was busy.
   */
  settingsManagedKeyValue: 'Current key ···{tail}',
  settingsManagedKeyUnclaimedValue: 'No key claimed yet',
  settingsManagedKeyHint: 'Claimed automatically by this device — nothing to fill in. Re-claim to replace it.',
  settingsManagedKeyClaim: 'Re-claim',
  settingsManagedKeyClaiming: 'Claiming…',
  settingsManagedKeyClaimed: 'Claimed — current key ends with ···{tail}',
  settingsManagedKeyStale: 'The key has changed — please re-claim',
  settingsManagedKeyBlockedClaim:
    'Claim a key first: this message was not sent. The Our-channel key is issued by the server and cannot be typed in.',
  settingsManagedKeyBlockedStale:
    'The key has changed — please re-claim: the local key is no longer the one issued by the server, so this message was not sent.',
  settingsManagedKeyClaimFailed: 'Claim failed: {message}',
  /**
   * #800: the built-in service sub-page no longer renders a key row at all (no input, no masked
   * display, no "re-claim"), so these three lines carry the explanation instead. Text only.
   */
  settingsBuiltinKeyAuto:
    'Keys for the built-in service are issued by the server — nothing to fill in here. The app re-aligns with the server on every start.',
  settingsBuiltinKeySyncing: 'Aligning the key with the server…',
  settingsBuiltinKeySynced: 'Aligned with the server — current key ends with ···{tail}',
  settingsManagedKeyNeedLogin: 'Sign in under Account & usage → Account first, then claim the key.',
  /**
   * #803：the automatic "make sure this device has a key" flow after sign-in / sign-up — when both
   * attempts fail the failure must stay on screen (error line + Retry), never be swallowed. The copy
   * carries the status code: "it failed" alone helps neither the user nor whoever reads the logs.
   */
  settingsManagedKeyEnsureFailed:
    'Could not get the key automatically: {reason} (tried {attempts} times) — messages cannot be sent right now.',
  settingsManagedKeyEnsureFailedHint:
    'Retry runs the same flow again: look for a key with this device name first, create one only when it is missing.',
  settingsManagedKeyFailNetwork: 'the request timed out or could not connect',
  settingsManagedKeyFailHttp: 'the server answered {status}',
  settingsManagedKeyFailEmpty: 'the server answered 2xx but returned no key value',
  /** #812: on-site facts in the failure banner — which key (first 6 chars) hit which address */
  settingsManagedKeyEnsureContext: 'Key in use: {keyPrefix}… (first 6 chars) · Request URL: {address}',
  settingsManagedKeyNoKeyYet: 'not claimed yet',
  settingsManagedKeyNoAddress: '(address unknown)',
  settingsBaseUrlLabel: 'Service URL',
  settingsBaseUrlPlaceholder: 'e.g. https://your-gateway.example.com',
  settingsModelPlaceholder: 'e.g. deepseek-v4.1-flash',
  settingsBaseUrlRequired: 'Enter a Service URL first',
  settingsTestLabel: 'Connection test',
  settingsModelLabel: 'Model',
  /** Read-only model row for built-in channels (#339) */
  settingsModelBuiltInHint: 'Read-only; nothing to fill in for this channel',
  settingsBaseUrlInvalid: 'Service URL must start with http:// or https:// and be a valid URL',
  settingsModelInvalid: 'Model cannot be empty',
  settingsModelsLoading: 'Loading…',
  settingsModelsRefresh: 'Refresh',
  settingsModelsEmpty: 'The endpoint returned no models; you can enter one manually.',
  settingsModelsFailed: 'Could not load models; you can enter one manually.',
  settingsModelsAvailable: 'Available models',
  settingsTest: 'Test',
  settingsTesting: 'Testing…',
  settingsTestOk: 'Connected (HTTP {status}); {count} models: {models}',
  settingsTestOkEmpty: 'Connected (HTTP {status}) but no model list was returned',
  settingsTestHttp: 'Request failed (HTTP {status}): {message}',
  settingsTestTimeout: 'Connection timed out; check the URL and your network',
  settingsTestNetwork: 'Cannot connect: {message} (wrong URL, service down, or blocked by CORS)',
  settingsTestBadJson: 'Response is not JSON: {message}',
  settingsTestApiKeyRequired: 'Enter an API Key first',
  settingsTestHtml:
    'The endpoint returned a web page (HTTP {status}) instead of API data; the path is usually wrong or the service is broken',
  /**
   * The upstream answered with a web page instead of data (#434): a gateway home
   * page / error page served with 200 + text/html. Plain language, and no retry.
   */
  upstreamReturnedHtml:
    'The upstream returned a web page instead of data, which usually means the gateway or proxy failed (a wrong endpoint URL looks the same). Retrying the same request will not change anything; expand the response summary below to see the content type and the first 200 characters.',

  // ---------- Chat background ----------
  settingsChatBackground: 'Chat background',
  settingsChatBackgroundDescription:
    'Stored on this device only (IndexedDB), never uploaded; resized to 1600px max edge',
  settingsChatBackgroundUpload: 'Upload',
  settingsChatBackgroundClear: 'Clear',
  settingsChatBackgroundSaved: 'Applied to the chat area',
  settingsChatBackgroundCleared: 'Cleared; the chat area is back to default',
  settingsChatBackgroundFailed: 'Could not process this image; try a JPG or PNG',
  settingsChatBackgroundClearConfirm: 'Remove the current chat background?',

  // ---------- Feedback & logs ----------
  feedbackCellLabel: 'Feedback & logs',
  feedbackCellDescription:
    'Uploads the recent activity logs with your report (redacted on this device); never includes chats or API keys',
  feedbackCellAction: 'Send feedback',
  feedbackDialogTitle: 'Feedback & logs',
  feedbackDescriptionLabel: 'What went wrong',
  feedbackDescriptionPlaceholder: 'Describe the issue and how to reproduce it',
  feedbackDescriptionRequired: 'Enter a description first',
  feedbackCategoryLabel: 'Category',
  feedbackCategoryBug: 'Bug report',
  feedbackCategoryFeature: 'Feature request',
  feedbackCategoryOther: 'Other',
  feedbackLogPreview: 'Log preview',
  feedbackLogCount: '{count} entries',
  feedbackLogPreviewHint:
    'Keys and signed parameters are redacted on this device; filters only affect the preview, not what is submitted',
  feedbackLogEmpty: 'No local logs yet',
  feedbackLogSummary: 'Showing the latest {shown} of {total} entries; submission carries up to {limit}',
  feedbackLogSearchLabel: 'Search logs',
  feedbackLogSearchPlaceholder: 'Search message or meta values (e.g. url.path, 404, timeout)',
  feedbackLogFilterLevel: 'Filter by level',
  feedbackLogFilterKind: 'Filter by event kind',
  feedbackLogFilterClear: 'Clear filters',
  feedbackLogGroupToggle: 'Group by operation',
  feedbackLogGroupNote:
    'No traceId yet: groups use a conservative "gap ≤ 2s + same kind family" heuristic (interim)',
  feedbackLogGroupChat: 'One chat interaction',
  feedbackLogGroupNet: 'One network request',
  feedbackLogGroupImport: 'One import',
  feedbackLogGroupMisc: 'Other entries',
  feedbackLogGroupCount: '{count}',
  feedbackLogNoMatch: 'No matching logs',
  feedbackLogFew: 'Only {count} local entries (just launched or just cleared?)',
  feedbackLogCopyEntry: 'Copy this entry',
  feedbackLogCopied: 'Entry copied (with full meta)',
  feedbackLogTruncated: '{matched} matched; showing the latest {shown}',
  feedbackExport: 'Export feedback logs',
  feedbackSaveFile: 'Save log file',
  feedbackExportBusy: 'Saving…',
  feedbackExportHint: 'Save redacted JSON offline: version, device, category, logs and current submission failure. Excludes description, contact, screenshots, chat and payment bodies. Saving does not submit feedback.',
  feedbackExportWebSaved: 'Download started: {filename}. Check browser downloads or the Downloads folder. This does not submit feedback.',
  feedbackExportNativeSaved: 'Saved to the location selected in the system file picker: {filename}. This does not submit feedback.',
  feedbackExportCancelled: 'Save cancelled. Logs and form contents are retained.',
  feedbackExportFailed: 'Save failed. Logs and form contents are retained; please retry.',
  feedbackExportReadFailed: 'Latest snapshot read failed; exported the retained preview snapshot.',
  feedbackExportTruncated: 'The file reached the 4 MiB limit; truncation and omitted counts are marked.',
  feedbackTransport: 'Transport: {name}',
  feedbackScreenshot: 'Screenshot (optional)',
  feedbackScreenshotPick: 'Choose from photos',
  feedbackScreenshotRemove: 'Remove',
  feedbackScreenshotFailed: 'Could not process this image; try another one',
  feedbackScreenshotNotImage: 'Only images can be attached as a screenshot (png, jpg, webp…)',
  feedbackScreenshotUndecodable: 'This image cannot be opened (corrupt or not really an image); try another one',
  feedbackScreenshotReady: 'Compressed and attached',
  feedbackSubmit: 'Submit',
  feedbackSubmitting: 'Submitting…',
  feedbackTicketLabel: 'Submitted, ticket',
  feedbackTicketLogSize: '(log {size})',
  feedbackDone: 'Done',
  feedbackClearLogs: 'Clear local logs',
  feedbackLogsCleared: 'Local logs cleared',
  feedbackErrorNetwork: 'Network failure: cannot reach the feedback service; check your connection',
  feedbackErrorTimeout: 'Request timed out; try again later',
  feedbackErrorTooLarge: 'Screenshot, description or essential logs exceed the upload budget (180 KiB) or server limit. Use a smaller screenshot or shorter description; screenshots are never silently removed.',
  feedbackErrorUnauthorized: 'Upload credential is invalid; retry later or contact the maintainer',
  feedbackErrorRateLimited: 'Too many submissions; try again later',
  feedbackErrorServer: 'Server error; try again later',
  feedbackErrorRejected: 'The server rejected this report; check the content and retry',
  feedbackErrorUnknown: 'Upload failed; try again later',

  feedbackIntegrityCheck: 'Check log coverage',
  feedbackIntegrityTitle: 'Log coverage self-check',
  feedbackIntegrityCount: 'Entries: {count} (max 500, last 30 minutes)',
  feedbackIntegritySpan: 'Time span: {span}',
  feedbackIntegrityKinds: 'Event kinds covered: {count}',
  feedbackIntegrityKindList: 'Covered: {kinds}',
  feedbackIntegrityMissing: 'Missing: {kinds}',
  feedbackIntegrityNone: 'none',
  feedbackWarningsTitle: 'Pre-submit hints (upload still allowed)',
  feedbackWarningFewLogs: 'Very few logs; describe the steps to reproduce',
  feedbackWarningNoNetwork: 'No network records captured',
  feedbackWarningShortSpan: 'Time span under 1s; the app may have just started',
  feedbackActionsLabel: 'Recent actions: {actions}',
  feedbackContactLabel: 'Contact (optional)',
  feedbackContactPlaceholder: 'Email or WeChat so we can reach you',
  // ---------- Feedback draft: kept after cancel, refilled on reopen (Issue #31) ----------
  feedbackDraftRestored: 'Restored what you had not submitted yet',
  feedbackDraftScreenshotHint: 'The previous image is not kept; pick it again',
  feedbackDraftClear: 'Clear filled-in content',
  feedbackDraftClearHint: 'Clears description, contact and screenshot; next open starts empty',
  feedbackDraftClearConfirm: 'Clear what you filled in? This cannot be undone',
  feedbackDraftCleared: 'Filled-in content cleared',
  // #261: same device fingerprint claimed again, server granted nothing new. Never render this as success.
  /** Money unit (#94 / #487): yuan (1 yuan = 1 credit), appended by formatPoints in services/ours/api.ts — never hardcode a unit there */
  oursPointsUnit: 'CNY',
  oursQuotaValue: '{points}',
  oursQuotaNeedsClaim: 'Not claimed yet: tap “Claim / re-claim” above to see quota',
  oursQuotaNeedsBind: 'This device is not bound yet: claim a new key or bind an existing one',
  // #234: server now rewards the inviter only; the invitee just binds the relationship (reward_points: 0),
  // so the success copy no longer reports earned credit; rule numbers always come from invite_rules
  oursPlansLoading: 'Loading plans…',
  oursPlansFailed: 'Plans failed to load, try again',
  oursBuyAction: 'Pay',
  // Purchase entry (Issue #331): plans are all retired, open the shop checkout page instead
  oursPayTitle: 'Purchase',
  oursPayAction: 'Go to purchase',
  oursPayBusy: 'Fetching checkout page…',
  oursPayEmpty: 'The plan list has been retired. Tap “Go to purchase” to pick a plan on the shop page.',
  oursPayHint: 'Opens the shop checkout page inside the app. The shop delivers the card code right after payment; close the page and you are back here.',
  oursPayUnavailable: 'Payment channel is temporarily unavailable, please try again later',
  oursPayOpenFailed: 'Could not open the checkout page inside the app, please try again later',
  oursRedeemAction: 'Redeem',
  oursRedeemSuccess: 'Redeemed. +{points}',
  oursRedeemPending: 'Redemption is being processed, refresh quota shortly',
  oursKeyProbeValid: 'Key active {tail}',
  oursKeyProbeInvalid: 'Key not active yet {tail}',
  oursKeyProbeNetwork: 'Key check failed: network unavailable',
  oursKeyProbeTimeout: 'Key check timed out',
  // #234: A invited B and B types A's code → server returns 409 circular_invite
  // #421 email accounts (bind / sign in on a new device) — one key per row of the issue table
  oursEmailCodePlaceholder: '6-digit code',
  // 卡密 / 支付服务错误码
  oursErrBadJson: 'Malformed request, retry',
  oursErrUnauthorized: 'Authentication failed: claim or enter a Key again',
  oursErrForbidden: 'Order token mismatch, this order cannot be queried',
  oursErrNotFound: 'Record not found',
  oursErrCardNotFound: 'Card code not found, check it and retry',
  oursErrCardUsed: 'This card code was already used, do not submit again',
  oursErrCardMissing: 'Enter a card code',
  oursErrKeyMissing: 'Claim or enter a Key first',
  oursErrKeyInvalid: 'Key is invalid: claim or enter a new one',
  oursErrVerifyUnavailable: 'Quota service temporarily unavailable, retry later',
  oursErrRateLimited: 'Too many requests, retry later',
  oursErrPlanNotFound: 'Plan not found',
  oursErrPlanMissing: 'Select a plan first',
  oursErrNetwork: 'Network unavailable, retry later',
  oursErrTimeout: 'Request timed out, retry later',
  oursErrInvalidResponse: 'Unexpected server response, retry later',
  oursErrUnknown: 'Operation failed, retry later',
  errorScreenTitle: 'This page could not be displayed',
  errorScreenDescription:
    'The app hit an error while rendering this screen, so it stopped here instead of failing silently. Your saved chats are not deleted and will be there after a reload.',
  errorScreenReload: 'Reload app',
  errorScreenCopyDiagnostics: 'Copy diagnostics',
  errorScreenCopied: 'Diagnostics copied',
  errorScreenCopyFailed: 'Copy failed, please retry',
  errorScreenHint:
    'If a reload does not help, copy the diagnostics into your feedback (error location and version only; no chat content or API keys).',
  // Issue #72
  oursErrCardLeased: 'This card code has moved to the in-app redemption channel. Redeem it in the app.',
  oursErrCardNotFoundOrExpired: 'Card code does not exist or has expired',
  oursErrApiKeyNotIssued: 'Claim a key in the app first, then redeem',
  // Issue #46: thinking display mode
  settingDialogThinkingDisplayLabel: 'Thinking process',
  settingDialogThinkingDisplayDescription: 'How thinking content appears in messages when deep thinking is on. Switching applies to already open chats immediately.',
  settingDialogThinkingDisplayCollapsed: 'Collapsed',
  settingDialogThinkingDisplayExpanded: 'Expanded',
  settingDialogThinkingDisplayHidden: 'Hidden',
  // Issue #18: auto session title system prompt (English side must stay Chinese-free)
  autoTitlePromptIntro: 'Generate a concise title for this AI conversation from the user message provided.',
  autoTitlePromptFormat:
    'Output only the title itself, as one line of plain text: no quotes, prefixes, explanations, Markdown, XML or control characters, and never output code.',
  autoTitlePromptLanguage: 'Use the language of the message.',
  autoTitlePromptLength: 'Target length: about 8–14 characters for Chinese, or 3–5 words for English.',
  autoTitlePromptFallback:
    'If the message carries too little information, still give a short best-guess title (for example "Greetings"), without explanation.',
  oursPayRecordsCopyCard: 'Copy card code',
  oursPayRecordsCopied: 'Card code copied',
  // Issue #45: unified request timeout notice (kept apart from network failure and 4xx/5xx)
  /// #568: this stage only covers "request sent → response headers", hence "connect"
  requestTimeout:
    'Connect timeout (no response headers within {seconds}s — the request never connected upstream, so this is not an upstream error). Check your network or proxy, then tap “regenerate” to send it again.',
  // Issue #106: double-tap the mobile title bar to jump back to the first message
  scrollToFirstMessage: 'Back to the first message (double-tap the title)',
  scrollToFirstMessageHint: 'Double-tap to top',
  // Issue #102: message-area reading settings (font size / weight / line height)
  settingDialogReadingGroupLabel:
    'Applies to the message area only: chat answers, thinking text and your own messages. The settings panel and the input box stay as they are.',
  settingDialogReadingFontSize: 'Font size',
  settingDialogReadingFontWeight: 'Font weight',
  settingDialogReadingLineHeight: 'Line height',
  settingDialogReadingSizeSmall: 'Small',
  settingDialogReadingSizeStandard: 'Standard',
  settingDialogReadingSizeLarge: 'Large',
  settingDialogReadingSizeXLarge: 'Extra large',
  settingDialogReadingWeightRegular: 'Regular',
  settingDialogReadingWeightMedium: 'Medium',
  settingDialogReadingWeightBold: 'Bold',
  settingDialogReadingLineCompact: 'Compact',
  settingDialogReadingLineStandard: 'Standard',
  settingDialogReadingLineRelaxed: 'Relaxed',
  settingDialogEnterKeyMode: 'Enter key behavior',
  settingDialogEnterKeyModeDescription:
    'Send on Enter, or insert a line break and use the send button — the soft-keyboard Enter key follows your choice.',
  settingDialogEnterKeySend: 'Enter sends (Shift + Enter for a new line)',
  settingDialogEnterKeyModifierSend: 'Ctrl / ⌘ + Enter sends (Enter for a new line)',
  settingDialogEnterKeyButtonOnly: 'Enter only adds a new line (use the send button)',
  // Window memory capacity notices (#399): eviction and rejection must be spoken, never silent.
  memoryEvicted:
    'This chat has reached its memory capacity; the {count} oldest entries were removed (this chat only)',
  memoryEntryTooLarge: 'This memory entry exceeds the per-entry limit ({kb} KB) and was not saved',
  // Issue #49: tolerant import — damaged messages are truncated, damaged chats skipped, and the
  // result view has to say which items were dropped and why.
  historyImportedPartial: 'Imported {count} chats, skipped {skipped} damaged items',
  historyImportSkippedTitle: 'Skipped {count} damaged items',
  historyImportSkippedHint: 'The rest of the chats and messages were imported',
  historyImportSkipScopeSession: 'Chat',
  historyImportSkipScopeMessage: 'Message',
  historyImportSkipScopeBranch: 'Branch',
  historyImportSkipWhereSession: 'Chat "{session}" could not be read at all',
  historyImportSkipWhereMessage: 'Message {message} in chat "{session}"',
  historyImportSkipWhereBranch: 'Chat "{session}" branch pointing at {message}',
  historyImportSkipMissingParent: 'missing parent message {parent}',
  historyImportSkipReasonBranches:
    'message branches are damaged (parent message missing, or roles do not connect)',
  historyImportSkipReasonFiles:
    'attachment data is damaged (image path escapes the folder, or the image is duplicated)',
  historyImportSkipReasonUnknown:
    'Unrecognized skip reason (from another version or a third-party archive)',
  settingDouyinLabel: 'Douyin ID',
  settingDouyinDescription: 'Tap the ID to copy it, then search for it in Douyin.',
  settingDouyinCopyAria: 'Copy Douyin ID',
  settingDouyinCopied: 'Douyin ID copied',
  oursErrCustomerNeedsKey:
    'Claim an API Key in the app first (without a Key we cannot resolve your customer id, so nothing was ordered)',
  backupEntryDuplicated: 'The entry "{entry}" appears twice in this ZIP, so it is impossible to tell which one to use. Choose the original DeepSeek export ZIP instead of a repacked one.',
  // "My purchases" (#158): entry, filters, pagination, card actions and error copy
  oursPurchasesLoading: 'Loading purchases…',
  oursPurchasesEmpty: 'No purchases yet. Once you buy a plan, every order shows up here.',
  oursPurchasesRetry: 'Retry',
  oursPurchasesGoRedeem: 'Redeem now',
  oursPurchasesErrUnknown: 'Could not load your purchases. Please retry later.',
  // #834: order status labels are mapped in the client (the new endpoint has no status_text)
  consumeOrderStatusCompleted: 'Completed',
  consumeOrderStatusPending: 'Awaiting payment',
  consumeOrderStatusExpired: 'Expired',
  consumeOrderStatusCancelled: 'Cancelled',
  consumeOrderStatusFailed: 'Payment failed',
  consumeOrderStatusRefunded: 'Refunded',
  consumeOrderStatusUnknown: 'Unknown status',
  // Boot-guard copy (#180 / #104). Identical to the inline COPY table in src/index.html;
  // tests/unit/compat-guard-diagnostics.test.mjs compares both sides.
  //
  // Note (issue #413): the guard only renders after the app bundle — and therefore the i18n
  // module — is already dead, so these templates are inlined in the HTML and never read from
  // here at runtime. Only pre-existing keys stay in this table; the 17 keys #104 added
  // (outdated-engine lead / five env fields / copy + truncation hints) were defined-but-unused
  // (check-i18n R4) and are gone, with a verbatim reference copy in
  // tests/fixtures/compat-boot/compat-boot-copy.mjs. Add new fallback copy to the COPY table in
  // src/index.html plus that fixture, **not** here.
  compatBootTitle: 'This page could not start',
  compatBootLead: 'This page needs a newer Android System WebView (or browser) to open properly.',
  compatBootMissing: 'Missing runtime features: {apis}',
  compatBootRuntimeError: 'A script error stopped this page from starting.',
  compatBootTimeout: 'The page script did not start within 12 seconds (outdated engine or failed to load).',
  compatBootHowTo:
    'To update: open your app store, search for "Android System WebView" and update it, then reopen this app.',
  compatBootFooter: 'If it still fails after updating, report the engine version above with a screenshot of this page.',
  // The "unreachable" tier for URL imports (issue #18): the device has a network but cannot reach
  // the import service (DNS failure / no route / link dropped mid-switch). It must not reuse the
  // offline wording — telling users to check a connection that is actually fine sends them nowhere.
  historyImportUrlUnreachable: 'Cannot reach the import service right now. Please try again later.',
  historyImportReadFailed:
    'The archive finished downloading but this device could not read it (usually low memory). Close other apps and try again, or restart the app.',
  updateCacheFallbackTitle: 'Cached data — may not be up to date',
  updateCacheFallbackNote:
    'This is the release list fetched successfully at {time} ({count} record(s)). The update service cannot be reached right now, so it may already be out of date.',
  updateManualDownload: 'Download the latest version manually',
  updateManualOpenFailed:
    'Could not open the download page inside the app. Try again later, or copy the diagnostics and send them to us.',
  /**
   * Update dialog and policy (issue #517): forced / soft / normal.
   * Only user-facing actions and known facts — no internal names, error codes or SOPs.
   */
  updateDialogTitleNormal: 'Update available',
  updateDialogTitleSoft: 'A new version is available',
  updateDialogTitleForced: 'Update required to keep using the app',
  updateDialogChangesTitle: "What's new",
  updateDialogLabelSize: 'Download size',
  updateDialogLabelPublishedAt: 'Released',
  updateDialogLabelCurrent: 'Current version',
  updateDialogPublishedUnknown: 'Not provided',
  updateDialogForcedNotice: 'You need to update before you can keep using this app.',
  updateDialogBelowMinimumNotice:
    'Your current version {current} is below the minimum supported version. Update to {version} to keep using the app.',
  updateDialogForcedReason: 'Note: {reason}',
  updateDialogSoftNotice: 'You can be reminded later — this prompt stays hidden for {hours} hours.',
  updateDialogSnooze: 'Remind me later',
  updateDialogClose: 'Close',
  updateDialogCancel: 'Cancel',
  updateDialogSnoozed: 'Reminder postponed — this prompt stays hidden for {hours} hours.',
  // ---------------------------------------------------------------------------
  // Refactor key skeleton (prep for #487): sign-in/sign-up, account and consumption,
  // card-key redemption, invites, email binding. Only new keys here; existing text above is untouched.
  // These keys have no caller until the UI lands, which is expected and registered in
  // scripts/check-i18n.mjs ORPHAN_BASELINE.
  // ---------------------------------------------------------------------------

  // Sign-in / sign-up (sub2api /api/v1/auth)
  sub2authEmail: 'Email',
  // #727: the three "model source" options now use the accountConsumeSource* keys
  // (three-row list wording — no duplicate definitions of the same strings).
  // #794: the third-party protocol segmented control (settingsThirdPartyProtocol /
  // settingsProtocolOpenai / settingsProtocolAnthropic) is gone — the protocol is derived from
  // the address and model by services/api/protocolDetect.ts. zh/en deleted together.
  settingsAuthEmailPlaceholder: 'Email',
  settingsAuthPasswordPlaceholder: 'Password (at least 6 characters)',
  settingsAuthCodePlaceholder: 'Verification code',
  settingsAuthSendCode: 'Send code',
  settingsAuthCountdown: '{seconds}s',
  settingsAuthSkip: 'Skip sign-in',
  settingsAuthHaveAccount: 'Already have an account? Sign in',
  settingsAuthForgotSent: 'Reset email sent — check your inbox',
  settingsAuthForgotNeedsEmail: 'Enter your email first, then tap "Forgot password"',
  // #797: confirm password on sign-up + show/hide password toggles
  settingsAuthConfirmPlaceholder: 'Re-enter your password',
  // #819: optional invitation code on sign-up (only when settings/public says invitation_code_enabled)
  settingsAuthInvitePlaceholder: 'Invitation code (optional)',
  /** The two entries differ (client-side check only — never sent to the server; blocked before submit) */
  settingsAuthPasswordMismatch: 'The two passwords do not match',
  /** Eye button accessible name — it names the action: hidden now → "Show password" */
  settingsAuthShowPassword: 'Show password',
  settingsAuthHidePassword: 'Hide password',
  // #795: forgot-password step
  settingsAuthForgotTitle: 'Reset password',
  settingsAuthForgotSend: 'Send reset email',
  settingsAuthForgotBack: 'Back to sign in',
  /**
   * Appended hint when the backend lacks the reset configuration (`frontend_url` / SMTP, #795).
   * The server answers `Password reset is not configured`; that alone gives the user no next step,
   * so the raw message is shown verbatim and this actionable line is added after it.
   */
  settingsAuthForgotNotReady: 'Password reset is not available yet — please contact support',
  sub2authPassword: 'Password',
  sub2authConfirmPassword: 'Confirm password',
  sub2authLogin: 'Log in',
  sub2authRegister: 'Sign up',
  sub2authForgotPassword: 'Forgot password',
  sub2authSendCode: 'Send verification code',
  /** Countdown placeholder: {seconds} comes from the server cooldown, never hardcoded */
  sub2authCodeSent: 'Code sent, resend in {seconds}s',
  sub2authCodeInvalid: 'Incorrect verification code',
  sub2authEmailInvalid: 'Invalid email address',
  sub2authCredentialInvalid: 'Incorrect account or password',
  sub2authLoginFailed: 'Login failed, try again',
  sub2authNetworkError: 'Network error, check your network and retry',
  sub2authLogout: 'Log out',
  sub2authSwitchAccount: 'Switch account',
  sub2authAccount: 'Account',
  sub2authSessionExpired: 'Session expired, please sign in again',
  sub2authRegisterSuccess: 'Account created',
  sub2authEmailVerifyRequired: 'Verify your email first',
  /** Server `reason:"REGISTRATION_DISABLED"` (403): sign-up is switched off (#735) — never "wrong password" */
  sub2authRegistrationDisabled: 'Sign-up is not open yet. Please try again later or contact the administrator.',
  /** Server `reason:"EMAIL_EXISTS"` (409): this email is already registered (#735) */
  sub2authEmailExists: 'This email is already registered. Please log in instead.',
  /** 403 without a usable business code (gateway/WAF block, unlisted reason): denied ≠ wrong password (#735) */
  sub2authForbiddenUnknown: 'This action was denied (no permission, or the feature is not available yet). Try again later or contact the administrator.',
  /** Server `reason:"USER_NOT_ACTIVE"` (403): the password is right but the account is disabled (#735) */
  sub2authUserNotActive: 'This account has been disabled. Please contact the administrator.',
  sub2authTwoFactorHint: 'Two-factor authentication is on, enter the 6-digit code from your authenticator app',

  // "Account & billing" page (three dialogs → one page, #482 / W1-C1 #487)
  accountConsumeTitle: 'Account & billing',
  accountConsumeTabCards: 'My cards',
  accountConsumeTabAccount: 'Account',
  // #727: the page is now "one full page + four sections" (model source / connectivity / wallet / account).
  accountConsumeGroupSource: 'Model source',
  accountConsumeSourceBuiltin: 'Built-in service',
  accountConsumeSourceThird: 'Third-party service',
  accountConsumeSourceOfficial: 'DeepSeek official service',
  accountConsumeSourceAnthropic: 'Anthropic-compatible service',
  accountConsumeSourceKeyInvalid: 'Invalid API key — check it and try again',
  // #807: the model-source page is a single accordion — three header states only, and the tick always
  // comes with a text label + tooltip (never a bare glyph).
  settingsSourceStatusCurrent: 'In use',
  settingsSourceStatusUnconfigured: 'Not configured',
  settingsSourceStatusClaiming: 'Claiming…',
  settingsSourceCurrentAria: 'Currently in use',
  settingsSourceConfirm: 'Use this source',
  settingsSourceBaseUrlFixed: 'Fixed address — nothing to fill in',
  settingsSourceSwitched: 'Switched to {name}',
  settingsSourceRetry: 'Retry',
  settingsSourceClaimNeedLogin: 'The built-in service key is claimed after sign-in — please sign in or sign up.',
  settingsSourceClaimNeedLoginAction: 'Sign in',
  accountConsumeSourcePickHint: 'Pick a source and press Save; the app uses it right away',
  accountConsumeWallet: 'My wallet',
  accountConsumeRemaining: 'Remaining balance',
  accountConsumeHistory: 'Spending history',
  accountConsumeHistoryEmpty: 'No spending yet',
  accountConsumeHistoryEmptyHint: 'Charges show up here after you use a model',
  accountConsumeHistoryMore: 'Load more',
  accountConsumeAccountId: 'Account ID',
  accountConsumeBindEmail: 'Linked email',
  accountConsumeLoginMethod: 'Sign-in method',
  accountConsumeLoginMethodEmail: 'Email',
  accountConsumeSignedOutCta: 'Log in / Sign up',
  accountConsumeSignOutConfirm: 'Sign out now?',

  // Login wall removed (#608): the account is now an *optional* capability inside "the built-in channels".
  // Three rules: ① the primary call to action is "fill in a Key", not "log in";
  // ② what you lose without an account is billing views only — chat / Keys / import-export stay;
  // ③ no "an account is safer" style claims (#421 boundary).
  accountOptionalHint: 'No account needed: fill in an API Key in Settings and every channel works',
  accountOptionalStatusLoggedOut: 'Not logged in — a Key alone is enough to chat',
  accountOptionalStatusLoggedIn: 'Logged in as {email}',
  accountOptionalBenefitsTitle: 'An account only adds these billing views',
  accountOptionalBenefitBalance: 'Balance and usage details (the built-in channels bill per account)',
  accountOptionalBenefitKeys: 'Key management: create, disable, delete',
  accountOptionalBenefitInvite: 'Invite code and rebate balance',
  accountOptionalKeep: 'Chat, channel Keys and import/export are unaffected — nothing is lost without an account',
  accountOptionalLoginEntry: 'Log in / sign up (optional)',
  accountOptionalChecking: 'Checking sign-in status…',
  // Primary CTA and where it lands (#608): chat first, account second
  accountFillKeyCta: 'Go enter an API Key',
  accountFillKeyHint: 'Settings → Data management → API Key; once filled you can chat right away',
  accountSignInCta: 'Sign in',
  quotaNeedLoginTitle: 'Log in to see your balance',
  quotaNeedLoginBody: 'Balance is billed per account; to chat only, just fill in a Key in Settings',
  inviteNeedLoginTitle: 'Log in to see your invites',
  inviteNeedLoginBody: 'Invite code and rebates live with the account; chat works without it',

  // Account and consumption (amounts are in yuan: 1 yuan = 1 credit; rendering goes through utils/money.ts — no FX on the client)
  consumeBalance: '¥{amount}',
  consumeBalanceApprox: 'About ¥{amount}',
  consumeQuota: 'Quota',
  consumeUsage: 'Usage',
  consumeUsageToday: 'Usage today',
  consumeUsageMonth: 'Usage this month',
  consumeCreateKey: 'Create Key',
  consumeKeyList: 'Key list',
  consumeKeyName: 'Key name',
  consumeKeyExpiresAt: 'Expires at',
  consumeKeyStatus: 'Status',
  consumeKeyStatusActive: 'Enabled',
  consumeKeyStatusInactive: 'Disabled',
  consumeCopyKey: 'Copy Key',
  consumeKeyCopied: 'Key copied',
  consumeDeleteKey: 'Delete Key',
  consumeDeleteConfirm: 'This cannot be undone. Delete this Key?',

  // Card-key redemption (keeps the existing "card key" wording, see #482)
  consumeRedeemTitle: 'Redeem card key',
  consumeRedeemPlaceholder: 'Enter the card key',
  consumeRedeemBusy: 'Redeeming…',
  /** Used while checking the redeem history after a timeout: never invite a second submit */
  consumeRedeemConfirming: 'Checking the redemption result, do not submit again',
  consumeRedeemSuccess: 'Redeemed',
  consumeRedeemFailed: 'Redemption failed, try again later',
  consumeRedeemCodeUsed: 'This card key was already used',
  consumeRedeemCodeInvalid: 'Invalid card key',
  // Auto-redeem right after returning from the payment page (#784)
  walletAutoRedeemNeedSignIn: 'Sign in and the card key is credited automatically',
  walletAutoRedeemCredited: 'Credited automatically: {amount}',
  walletAutoRedeemMasked: 'This card key is masked, so it cannot be redeemed automatically; enter the full key manually',
  walletAutoRedeemFailed: 'Automatic redemption did not complete',
  walletAutoRedeemDismiss: 'Got it',

  // Invites (sub2api aff; the invitation code can only be set once, at sign-up)
  inviteTitle: 'My invites',
  inviteCode: 'Invitation code',
  inviteCopyCode: 'Copy invitation code',
  inviteCount: 'Invited users',
  inviteRebateBalance: 'Rebate balance',
  inviteCodeAtRegister: 'Invitation code (optional)',
  inviteCodeInvalid: 'Invalid invitation code',
  inviteDisabled: 'Invites are not available',

  // Fill in an inviter after sign-in (#842 contract-first; entry is off by default, see inviteBindModel.ts)
  inviteBindLabel: "Inviter's invitation code",
  inviteBindPlaceholder: 'Enter invitation code',
  inviteBindSubmit: 'Submit',
  inviteBindSubmitting: 'Submitting…',
  inviteBindHint: "Enter the code of the person who invited you. It can only be set once and cannot be changed afterwards",
  inviteBindDone: 'Inviter linked',
  inviteBindDoneHint: 'The invitation is recorded and cannot be changed',
  inviteBindErrFormat: 'The code must be 4–32 letters, digits, underscores or hyphens',
  inviteBindErrInvalid: 'Invalid invitation code. Check it and try again (you cannot use your own code)',
  inviteBindErrFull: 'This inviter has no invitation slots left. Try a different code',
  inviteBindErrDisabled: 'Invites are not available yet',
  inviteBindErrUnauthorized: 'Your session has expired. Sign in again and retry',
  inviteBindErrRateLimited: 'Too many attempts. Try again later',
  inviteBindErrFailed: 'Could not link the inviter. Try again later',

  // Email binding (sub2api account-bindings)
  emailBindBind: 'Bind email',
  emailBindChange: 'Change email',
  emailBindUnbind: 'Unbind',
  emailBindSendCode: 'Send verification code',
  emailBindCodeSent: 'Code sent',
  emailBindSuccess: 'Email bound',
  emailBindUnbindSuccess: 'Email unbound',
  emailBindFailed: 'Binding failed, try again later',

  // On-screen copy for the normalized sub2api errors (#487): one key for every `ConsumeMessageKey`
  // in `src/services/consume/errors.ts` (27 of them). The consume layer only returns keys, so this
  // block is the single source of the sentence a user actually reads. Same three rules as zh.ts:
  //   · human + actionable — the next step (sign in / switch key / top up / contact support) is in the sentence;
  //   · never the words "unknown error" — `consumeErrUnknown` is the only fallback, every other key names a cause;
  //   · amounts use `{amount}` in yuan (1 yuan = 1 credit) and the symbol is added by utils/money.ts,
  //     never hardcoded here; rate-limit seconds use `{seconds}` (from `Retry-After`).
  consumeErrUnknown:
    'That request did not go through. Try again later, and send us this message if it keeps happening.',
  consumeErrNetwork: 'No network connection. Check your connection and try again.',
  consumeErrTimeout: 'The request timed out. Wait a moment and try again.',
  consumeErrUnsupported: 'This environment cannot reach the consume service directly — please test inside the App.',
  consumeErrBadRequest: 'Something in the form is not valid. Check it and try again.',
  consumeErrInvalidResponse:
    'The server sent data we could not read. Try again later, and tell us if it keeps happening.',
  consumeErrUnauthorized: 'Your session has expired. Please sign in again.',
  consumeErrAccountDisabled: 'This account has been disabled. Contact support.',
  consumeErrForbidden: 'You do not have permission for that. Check the permissions of this account.',
  consumeErrNotFound: 'That endpoint does not exist. Update to the latest version.',
  consumeErrRateLimited: 'Too many requests. Try again in {seconds} seconds.',
  consumeErrServerUnavailable: 'The service is temporarily unavailable. Try again later.',
  consumeErrKeyMissing: 'No API key yet. Add one first.',
  consumeErrKeyInvalid: 'Invalid API key. Check that you copied all of it.',
  consumeErrKeyDisabled: 'This API key is disabled. Enable it or use another one.',
  consumeErrKeyExpired: 'This API key has expired. Create a new one.',
  consumeErrKeyQuotaExhausted: 'This API key is out of quota. Use another key or raise the quota.',
  consumeErrKeyExists: 'An API key with that name already exists. Pick another name.',
  // No `{amount}` placeholder: the consume error mapper returns only the key, never the shortfall
  // (a leftover placeholder from #504 would be rendered literally to the user).
  consumeErrInsufficientBalance: 'Not enough balance. Please top up first.',
  consumeErrGroupNotAllowed: 'Your current group cannot use this key. Switch group or contact support.',
  consumeErrCardNotFound: 'No such card key. Check it and try again.',
  consumeErrCardNotFoundOrExpired: 'That card key does not exist or has expired. Check it and try again.',
  consumeErrCardUsed: 'This card key has already been used. Contact support if the balance did not arrive.',
  // #840: redeem-by-self duplicate (the server message is shown first; these are the fallbacks)
  consumeErrCardAlreadyRedeemed: 'You have already redeemed this card key.',
  consumeErrCardDisabled: 'This card key has been voided.',
  consumeRedeemProcessing: 'Confirming the redemption result',
  consumeErrInvitationInvalid: 'Invalid invitation code. Check it and try again.',
  consumeErrEmailCodeInvalid: 'The verification code is wrong or has expired. Request a new one.',
  // Email not verified yet (`EMAIL_VERIFY_REQUIRED`): name the next step instead of "try again later"
  consumeErrEmailVerifyRequired: 'Please verify your email first',
  consumeErrNotEnabled: 'This feature is not enabled yet. Contact support to enable it.',
  // A write returned 2xx but with no evidence (#660: email bind 200 + empty body, and the profile
  // recheck has no masked email either): the result is unknown, not success — always give the next step.
  consumeErrBindUnconfirmed: 'The binding result is unconfirmed. Retry, or check the account page later.',
  // Sign out everywhere (#679 item 5, security semantics): the revoke call returned 2xx but the recheck
  // cannot prove the sessions are gone. Never claim "signed out on all devices" — say it is unconfirmed
  // and give the next step (sign in again to verify / check your other devices).
  consumeErrRevokeUnconfirmed:
    'Sign-out was submitted but the result is unconfirmed (whether every device is signed out is still unknown): sign in again to verify, and check whether your other devices are still signed in.',
  // Unbind / update-key / delete-key "2xx but not in effect" (#679 items 2/3/4): ask the user to verify
  // the real state instead of showing success.
  consumeErrUnbindUnconfirmed: 'The unbind result is unconfirmed. Refresh the account page; retry if it still shows as bound.',
  consumeErrUpdateUnconfirmed: 'The change is unconfirmed. Refresh and check this key\'s current values, then save again if needed.',
  consumeErrDeleteUnconfirmed: 'The deletion is unconfirmed: this key may still be active and keep incurring charges. Refresh the list and retry.',
  // The line under a confirmed failure: HTTP status + the redacted upstream text (rendered by errorBlock)
  consumeErrUpstreamDetail: 'Server response: {detail}',
  // ---------------------------------------------------------------------------
  // W1-C2 account/consume panels (quota / account / invites / email binding, #487).
  // The `consumeErr*` error wording already landed in #504, so it is not redefined here;
  // these are only the plain labels the four panels need. Amounts are CNY (1 yuan = 1 quota):
  // the symbol comes from the panels' formatCurrency helper, never from a template here.
  // ---------------------------------------------------------------------------
  consumeBalanceLabel: 'Balance',
  consumeAccountTitle: 'Account',
  consumeProfileTitle: 'Account details',
  consumeUsed: 'Used',
  consumeRemaining: 'Remaining',
  consumeUnlimited: 'Unlimited',
  consumeRegisteredAt: 'Registered',
  consumeKeyEmpty: 'No Key yet. Name it and press “Create Key”.',
  consumeLoadMore: 'Load more',
  consumeLoadingMore: 'Loading…',
  consumeUsageEmpty: 'No usage records yet',
  consumeRequestsCount: '{count} requests',
  consumeTokensCount: '{count} tokens',
  consumeNoKeyTitle: 'No usable Key yet',
  consumeNoKeyBody: 'Balance and usage can only be read with a Key. Create one in the Account tab.',
  consumeKeyOnceTitle: 'This Key is shown only once',
  consumeKeyOnceBody:
    'For security the full Key is shown once, right after it is created, and cannot be viewed again. Copy and store it now.',
  consumeKeyTailOnly: 'The list only shows the last 4 characters',
  consumeKeyOnceSaved: 'I saved it',
  consumeKeyNameRequired: 'Give the Key a name first',
  consumeKeyDeleted: 'Deleted',
  consumeNeedLogin: 'Your session expired, please log in again',
  consumeLogoutConfirm: 'You will need to log in again to keep using the app. Log out?',
  consumeLogoutSuccess: 'Logged out',
  inviteRebateFrozen: '{amount} of it is frozen',
  emailBindNotBound: 'No email bound yet',
  emailBindCodeLabel: 'Verification code',
  emailBindUnbindConfirm: 'After unbinding, this email is no longer linked to the account. Unbind?',
  emailBindCannotUnbind: 'This is the only way to sign in to the account, so it cannot be unbound',
  // Legacy credit migration (#498 temporary tail, @remove-after 1.6.0):
  // called once after sign-in, failures stay silent; only the self-contained button
  // in src/legacy/migration/ uses these. Delete them together with that directory.
  legacyMigrateTitle: 'Migrate old credit',
  legacyMigrateDone: 'Old credit migrated: {amount}',
  legacyMigrateManual: 'To migrate your old credit, please contact support',
  legacyMigrateExpired: 'Credit migration has ended',
  legacyMigrateFailed: 'Migration failed',
  legacyMigrateDeviceMismatch: 'Device info does not match, please contact support',
  legacyMigrateAlreadyUnsettled: 'Already migrated; if it has not arrived, please contact support',
  legacyMigrateRetryAnyway: 'Migrate anyway',
  attachPickButton: 'Attach document (TXT / DOCX / PDF)',
  attachPickUnsupported:
    '"{name}" is not a supported document type. Only TXT, DOCX and PDF are supported',
  attachPickTooLarge: '"{name}" is {size}, over the limit of {limit} for this type',
  attachPickEmpty: '"{name}" is empty, so there is nothing to parse',
  attachPickTooMany: 'A message can hold at most {limit} documents; {count} extra were rejected',
  attachUnavailable: 'The attachment manager is not ready, so no document was added',
  attachChannelUnsupported:
    'This channel does not support document attachments: it has no working native file upload and does not use text injection. Switch to another channel',
  // #813: when the draft still holds documents added on another channel, name the way out
  attachDraftChannelUnsupported:
    'This channel does not support document attachments: {count} document(s) are still in the draft. Tap "Remove attachment" to clear them before sending, or switch to a channel that supports documents',
  // Five states + cancel
  attachStatusPending: 'Waiting to parse',
  attachStatusParsing: 'Parsing {percent}%',
  attachStatusParsingStage: 'Parsing · {stage}',
  attachStatusParsingPlain: 'Parsing…',
  attachStatusSuccess: 'Ready',
  attachStatusPartial: 'Partly ready · warnings: {count}',
  attachStatusFailed: 'Parsing failed. Tap for the reason',
  attachStatusCancelled: 'Parsing cancelled',
  attachCancel: 'Cancel parsing',
  attachRetry: 'Parse again',
  attachRemove: 'Remove attachment',
  attachRemoveFailed: 'Could not remove the attachment. Try again',
  // Detail panel
  attachOpenDetail: 'View attachment details',
  attachDetailWarnings: 'Warnings ({count})',
  attachDetailFailure: 'Why it failed',
  attachDetailCharacters: '{chars} characters · about {tokens} tokens',
  attachDetailPages: 'Page {extracted} of {total}',
  attachDetailRaw: 'Technical details',
  attachDetailTruncated: 'Content was too long and got cut: {rest} characters were not sent',
  attachWarnPageGap: '{total} pages in total, only {extracted} extracted',
  // Failure reasons (by the manager's reason code)
  attachFailUnsupportedFormat: 'Unsupported file type (only TXT, DOCX and PDF are supported)',
  attachFailMimeMismatch:
    'The file content does not match its extension; it may have been renamed',
  attachFailEmpty: 'The file is empty, so there is nothing to parse',
  attachFailTooLarge: 'The file is over the size limit for its type. Compress or split it and upload again',
  attachFailNotFound: 'This attachment record no longer exists. Add the file again',
  attachFailSourceMissing: 'The local copy is gone. Add the file again',
  attachFailNoParser: 'The parser for this format is not ready yet, so it cannot be parsed',
  attachFailUnknown: 'Something unexpected went wrong while parsing',
  // PDF parser hard-failure codes (#574): one plain sentence per cause, plus the next step.
  attachPdfErrNoTextLayer:
    'This PDF has no extractable text. Scanned PDFs are not supported yet, so please upload a PDF with a text layer',
  attachPdfErrTooManyPages: 'This PDF has {pages} pages, over the {limit}-page limit. Split it and upload again',
  attachPdfErrTooManyPagesPlain: 'This PDF is over the {limit}-page limit. Split it and upload again',
  attachPdfErrEncrypted: 'Encrypted PDFs are not supported yet. Remove the password protection and upload again',
  attachPdfErrNotPdf:
    'This file is not a valid PDF (its content does not match the extension). Check the file and upload again',
  attachPdfErrFileTooLarge: 'This PDF is over the size limit for its type. Compress or split it and upload again',
  attachPdfErrLibUnavailable:
    'The PDF parser component failed to load. Try again; if it keeps failing, check your network and reload the page',
  attachPdfErrOpenFailed: 'This PDF cannot be opened — the file may be corrupt. Export it again and upload',
  // Parsing stages (manager onProgress.stage)
  attachStageValidate: 'Checking the file',
  attachStageUnzip: 'Unpacking the document',
  attachStageParse: 'Reading the body',
  attachStageRender: 'Assembling the text',
  attachStageOpen: 'Opening the document',
  attachStagePage: 'Extracting page {page}',
  attachStageRead: 'Reading the file',
  attachStageDecode: 'Detecting the encoding',
  attachStageDone: 'Finishing up',
  // Cleanup and placeholders
  attachSweepFailed: 'Could not clean up unused attachments. Try again later',
  attachMissing: 'This attachment record was cleaned up, so details are unavailable',
  attachLoading: 'Loading attachment details',
  // Pre-send guard for unusable config (#490): one line per case, each saying the message was not sent
  sendBlockedBaseUrlEmpty:
    'The service address is empty, so this message was not sent. Fill in an address first.',
  sendBlockedBaseUrlNoProtocol:
    'The service address is missing http:// or https://, so this message was not sent. Add the protocol and try again.',
  sendBlockedBaseUrlEndpointPath:
    'The service address points at a concrete endpoint (e.g. …/chat/completions), so this message was not sent. Use the host only, a /v1 suffix is fine.',
  sendBlockedModelEmpty:
    'The model name is empty, so this message was not sent. Fill in a model name first.',
  sendBlockedModelSpace:
    'The model name contains a space, so this message was not sent. A model name must be one continuous string.',
  // Pre-send guard for a missing identity (#793): not signed in and no usable key — the request would
  // only carry empty credentials. The second line is the toast button (straight to Settings → Service → Provider)
  sendBlockedNoCredentials:
    'You are not signed in and no model provider is available, so this message was not sent. Sign in or pick a model provider first.',
  sendBlockedPickProvider: 'Choose provider',
  // #831 session-level branch (fork a stored chat into an independent new chat; not the same thing as
  // the in-chat message versions behind `BranchSwitcher`)
  sessionBranchMenuOption: 'Branch from this chat',
  sessionBranchFromMessage: 'Branch from this message',
  sessionBranchDialogTitle: 'Branch chat',
  sessionBranchConfirmFull:
    'Copy the whole chat ({count} messages) into a new chat. Later changes do not affect each other',
  sessionBranchConfirmNode:
    'Branching at message {kept}. The {dropped} message(s) after it will not be carried over',
  sessionBranchAttachmentsNote: 'Attachments are shared by reference; file contents are not copied',
  sessionBranchNameLabel: 'New chat name',
  sessionBranchCreate: 'Create branch',
  sessionBranchCreateFailed: 'The branch was not created. Try again later',
  sessionBranchTitleSuffix: ' (branch)',
  sessionBranchBadge: 'Branch',
  sessionBranchBadgeFrom: 'Branched from "{title}"',
  sessionBranchSourceMissing: 'Source is not on this device',
  sessionBranchOpenParent: 'Go to source chat',
  sessionBranchAttachmentMissing:
    'Attachment unavailable: {count} attachment(s) have no file on this device. You can keep chatting',
} satisfies Record<keyof typeof zh, string>
