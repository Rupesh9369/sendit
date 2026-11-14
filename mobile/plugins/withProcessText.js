const { withAndroidManifest, withMainActivity } = require('@expo/config-plugins');

// Adds "Send to Sendit" to the text selection menu. The selected text is written to a small file
// in the app's private storage, and the app reads it the next time it opens or comes to the front.
const HANDLER = `
  private fun handleProcessText(intent: android.content.Intent?) {
    if (intent?.action != android.content.Intent.ACTION_PROCESS_TEXT) return
    val text = intent.getCharSequenceExtra(android.content.Intent.EXTRA_PROCESS_TEXT)?.toString() ?: return
    java.io.File(filesDir, "pending_text.txt").writeText(text)
  }

  override fun onNewIntent(intent: android.content.Intent?) {
    super.onNewIntent(intent)
    handleProcessText(intent)
  }
`;

module.exports = (config) => {
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    const activity = app.activity.find((a) => a.$['android:name'] === '.MainActivity');
    activity['intent-filter'] = activity['intent-filter'] || [];
    activity['intent-filter'].push({
      action: [{ $: { 'android:name': 'android.intent.action.PROCESS_TEXT' } }],
      category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      data: [{ $: { 'android:mimeType': 'text/plain' } }],
    });
    return cfg;
  });

  config = withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('handleProcessText')) {
      src = src.replace('super.onCreate(null)', 'super.onCreate(null)\n    handleProcessText(intent)');
      src = src.replace(
        /class MainActivity : ReactActivity\(\) \{/,
        (m) => `${m}\n${HANDLER}`,
      );
    }
    cfg.modResults.contents = src;
    return cfg;
  });

  return config;
};
