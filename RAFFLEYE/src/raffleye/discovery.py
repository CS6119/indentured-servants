"""Topic boundaries shared by search, extraction and Discord delivery."""

import re
import unicodedata

from .models import Post

WUWA_QUERY = (
    '("Wuthering Waves" OR WutheringWaves OR WuWa OR WuwaTwt OR WuwaGiveaway '
    "OR WutheringWavesGiveaway OR WutheringWavesTwt OR WutherWaves OR 鳴潮 OR 鸣潮)"
)
WUWA_MARKER = re.compile(
    r"(?<![a-z0-9_])(?:wuwa|wuthering[\s_-]*waves|wutherwaves)(?:giveaways?|twt)?(?![a-z0-9_])"
    r"|#(?:wuwa|wutheringwaves|wutherwaves)[a-z0-9_]*|鳴潮|鸣潮",
    re.I,
)
GIVEAWAY_MARKER = re.compile(r"give\s*aways?|sweepstakes|raffles?|抽獎|抽奖", re.I)


def profile_qualified(post: Post) -> bool:
    profile = unicodedata.normalize("NFKC", post.author_name + " " + post.author_description)
    profile = re.sub(r"https?://\S+|@[A-Za-z0-9_]+", "", profile)
    return bool(WUWA_MARKER.search(profile) and GIVEAWAY_MARKER.search(profile))


def matches_topic(post: Post, topic: str) -> bool:
    if topic == "all":
        return True
    # A username or URL alone is not evidence that the giveaway concerns this game.
    text = unicodedata.normalize("NFKC", post.text)
    text = re.sub(r"https?://\S+|@[A-Za-z0-9_]+", "", text)
    return bool(WUWA_MARKER.search(text)) or profile_qualified(post)


def scoped_query(query: str, topic: str) -> str:
    if topic == "all":
        return query
    if WUWA_QUERY not in query:
        query = f"({query}) {WUWA_QUERY}"
    if "-is:reply" not in query:
        query += " -is:reply"
    return query
