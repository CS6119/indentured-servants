from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="RAFFLEYE_", extra="ignore")

    source: Literal["mock", "x", "apify"] = "mock"
    extractor: Literal["rules", "openai"] = "rules"
    giveaway_topic: Literal["all", "wuwa"] = "all"
    profile_watch_limit: int = Field(default=5, ge=0, le=20)
    notification_interval_seconds: int = Field(default=300, ge=60, le=86400)
    post_screenshots: bool = False
    screenshot_browser_channel: Literal["", "msedge", "chrome"] = ""
    db_path: Path = Path("data/raffleye.sqlite3")
    x_bearer_token: SecretStr = SecretStr("")
    apify_token: SecretStr = SecretStr("")
    apify_dataset_id: str = ""
    apify_authorized: bool = False
    apify_fallback: bool = False
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""
    discord_token: SecretStr = SecretStr("")
    discord_guild_id: int = 0
    global_query: str = "(giveaway OR sweepstakes OR 抽獎) -is:retweet"
    poll_seconds: int = Field(default=60, ge=10)
    global_interval_seconds: int = Field(default=900, ge=60)
    lookback_hours: int = Field(default=24, ge=1, le=144)
    x_search_mode: Literal["recent", "all"] = "recent"
    backfill_hours: int = Field(default=144, ge=1, le=8760)
    backfill_interval_hours: int = Field(default=24, ge=1, le=168)
    page_size: int = Field(default=25, ge=10, le=100)
    queries_per_tick: int = Field(default=4, ge=2, le=50)
    extraction_batch: int = Field(default=25, ge=1, le=100)
    daily_x_requests: int = Field(default=100, ge=0)
    daily_x_posts: int = Field(default=2500, ge=0)
    daily_apify_requests: int = Field(default=50, ge=0)
    daily_ai_requests: int = Field(default=100, ge=0)
    daily_estimated_usd: float = Field(default=2, ge=0)
    monthly_estimated_usd: float = Field(default=20, ge=0)
    x_request_reserve_usd: float = Field(default=0, ge=0)
    apify_request_reserve_usd: float = Field(default=0, ge=0)
    ai_request_reserve_usd: float = Field(default=0, ge=0)
    ai_max_output_tokens: int = Field(default=2500, ge=500, le=8000)
    max_post_chars: int = Field(default=12000, ge=1000, le=30000)
    ending_soon_minutes: int = Field(default=60, ge=1)

    @model_validator(mode="after")
    def live_credentials(self):
        if self.x_search_mode == "recent" and self.backfill_hours > 144:
            raise ValueError(
                "Recent search backfill is limited to 144 hours; longer windows require all search"
            )
        if self.source == "x" and (
            not self.x_bearer_token.get_secret_value() or self.x_request_reserve_usd <= 0
        ):
            raise ValueError("X requires a bearer token and positive X_REQUEST_RESERVE_USD")
        if self.source == "apify" or self.apify_fallback:
            if not (
                self.apify_authorized
                and self.apify_token.get_secret_value()
                and self.apify_dataset_id
                and self.apify_request_reserve_usd > 0
            ):
                raise ValueError("Apify requires authorized dataset, token, ID and positive request reserve")
        if self.extractor == "openai":
            if not (
                self.openai_api_key.get_secret_value()
                and self.openai_model
                and self.ai_request_reserve_usd > 0
            ):
                raise ValueError("OpenAI requires API key, model and positive AI_REQUEST_RESERVE_USD")
        return self
