const { config, validateConfig } = require('./config');
const { distribute } = require('./distributor');
const { reviewContent } = require('./services/aiReviewer');
const logger = require('./utils/logger');

/**
 * Simple CLI for content distribution
 * Usage: node src/index.js --content "Your post" --media ./image.jpg --platforms facebook,wordpress,drive
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const content = getArg('content');
  const title = getArg('title');
  const mediaPath = getArg('media');
  const platformsArg = getArg('platforms');
  const dryRun = args.includes('--dry-run');
  const skipReview = args.includes('--skip-review');

  if (!content) {
    console.log(`
  Content Distributor CLI
  =======================

  Usage:
    node src/index.js --content "Your post text" [options]

  Options:
    --content     Post content text (required)
    --title       Post title for WordPress (optional, auto-generated if omitted)
    --media       Path to image/video file (optional)
    --platforms   Comma-separated: facebook,wordpress,drive (default: all)
    --dry-run     Preview without posting
    --skip-review Skip AI brand review

  Examples:
    node src/index.js --content "Check out our new product!" --media ./photo.jpg
    node src/index.js --content "Hello world" --platforms facebook --dry-run
    `);
    process.exit(0);
  }

  if (dryRun) {
    process.env.DRY_RUN = 'true';
  }

  const platforms = platformsArg ? platformsArg.split(',') : ['facebook', 'wordpress', 'drive'];

  console.log('\n  📝 Content Distribution');
  console.log(`  Content: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`);
  console.log(`  Media: ${mediaPath || 'none'}`);
  console.log(`  Platforms: ${platforms.join(', ')}`);
  console.log(`  Dry-run: ${config.dryRun || dryRun ? 'YES' : 'NO'}\n`);

  // AI Review
  if (!skipReview) {
    console.log('  🤖 Running AI brand review...');
    const review = await reviewContent(content);

    if (!review.approved) {
      console.log('  ⚠️  Content review found issues:');
      review.issues.forEach((issue, i) => {
        console.log(`  ${i + 1}. [${issue.type}] ${issue.description}`);
      });
      console.log(`\n  📝 Suggested content: "${review.suggestedContent}"\n`);
      console.log('  Use --skip-review to bypass, or fix the content and try again.');
      process.exit(1);
    }

    console.log('  ✅ Content approved by AI reviewer\n');
  }

  // Distribute
  console.log('  🚀 Distributing...\n');
  const result = await distribute({ content, title, mediaPath, platforms });

  // Display results
  console.log('  📊 Results:');
  result.results.forEach((r) => {
    const status = r.success ? '✅' : '❌';
    console.log(`  ${status} ${r.platform}: ${r.success ? 'Success' : r.error}`);
    if (r.url) console.log(`     URL: ${r.url}`);
    if (r.results) {
      r.results.forEach((sub) => {
        const subStatus = sub.success ? '✅' : '❌';
        console.log(`     ${subStatus} ${sub.pageId || sub.type || ''}: ${sub.success ? 'OK' : sub.error}`);
      });
    }
  });

  console.log(`\n  ⏱️  Completed in ${result.elapsed}\n`);
}

main().catch((err) => {
  logger.error('CLI error', { error: err.message });
  console.error('Error:', err.message);
  process.exit(1);
});
