"""Screenshot only the public, official X embedded post; never use account cookies."""

import asyncio
import hashlib
import logging
from pathlib import Path
from time import time

from .config import Settings
from .models import Post

log = logging.getLogger(__name__)


class PostScreenshots:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.directory = settings.db_path.parent / "post-screenshots"
        self.lock = asyncio.Lock()

    def cache_path(self, post: Post) -> Path:
        version = hashlib.sha256(post.text.encode()).hexdigest()[:12]
        return self.directory / f"{post.id}-{version}.png"

    async def get(self, post: Post) -> Path | None:
        if not self.settings.post_screenshots or post.source == "mock":
            return None
        async with self.lock:
            path = self.cache_path(post)
            if path.exists() and 0 < path.stat().st_size <= 8_000_000:
                return path
            failure = path.with_suffix(".failed")
            if failure.exists() and time() - failure.stat().st_mtime < 3600:
                return None
            self.directory.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp.png")
            try:
                await asyncio.wait_for(self.capture(post, temporary), timeout=45)
                if not temporary.exists() or not 0 < temporary.stat().st_size <= 8_000_000:
                    raise ValueError("Invalid screenshot file")
                temporary.replace(path)
                failure.unlink(missing_ok=True)
                return path
            except Exception as exc:
                # Never send a login page/error screenshot, and never block the original-post link.
                temporary.unlink(missing_ok=True)
                failure.touch()
                log.warning("Post screenshot unavailable (%s)", type(exc).__name__)
                return None

    async def capture(self, post: Post, destination: Path):
        from playwright.async_api import async_playwright

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=True, channel=self.settings.screenshot_browser_channel or None
            )
            try:
                page = await browser.new_page(
                    viewport={"width": 620, "height": 2400}, device_scale_factor=2, locale="en-US"
                )
                page.set_default_timeout(15000)
                await page.set_content(
                    '<html><body style="margin:0;background:white"><div id="post"></div></body></html>'
                )
                await page.add_script_tag(url="https://platform.twitter.com/widgets.js")
                await page.wait_for_function("window.twttr && twttr.widgets")
                await page.evaluate(
                    """async id => await twttr.widgets.createTweet(id, document.getElementById('post'),
                    {conversation:'none', cards:'visible', theme:'light', dnt:true, width:550})""",
                    post.id,
                )
                frame = next(
                    (
                        f
                        for f in page.frames
                        if f.url.startswith("https://platform.twitter.com/embed/Tweet.html")
                    ),
                    None,
                )
                if frame is None:
                    raise ValueError("Official post embed missing")
                article = frame.locator("article").first
                await article.wait_for(state="visible")
                await article.locator('[data-testid="tweetText"]').first.wait_for(state="visible")
                # The timestamp must belong to the requested post, not a quoted post or login UI.
                timestamp = article.locator(f'a[href*="/status/{post.id}"] time').last
                await timestamp.wait_for(state="visible")
                await article.evaluate("""async element => {
                    await Promise.all([...element.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
                    element.querySelectorAll('video').forEach(video => video.pause());
                }""")
                bounds, end = await article.bounding_box(), await timestamp.bounding_box()
                if not bounds or not end:
                    raise ValueError("Post bounds missing")
                height = end["y"] + end["height"] + 12 - bounds["y"]
                if not 100 <= height <= 6000 or not 300 <= bounds["width"] <= 600:
                    raise ValueError("Unexpected post geometry")
                # Crop at the post timestamp: no reply controls, thread, sidebar or login banner.
                await page.screenshot(
                    path=str(destination),
                    clip={"x": bounds["x"], "y": bounds["y"], "width": bounds["width"], "height": height},
                    animations="disabled",
                )
            finally:
                await browser.close()
