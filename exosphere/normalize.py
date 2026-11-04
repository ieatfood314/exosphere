"""Turn twscrape tweets into the small JSON the site renders."""

import html
import re

TCO = re.compile(r"\s*https?://t\.co/\w+")
MAX_VIDEO_BITRATE = 2_500_000


def avatar(url: str | None) -> str:
    return re.sub(r"_normal(\.\w+)$", r"_200x200\1", url or "")


def clean_text(tweet) -> str:
    text = tweet.rawContent
    start = (tweet.displayTextRange or [0])[0]
    if tweet.inReplyToTweetId and start:
        text = text[start:]  # X hides the leading @mentions on a reply
    for link in tweet.links or []:
        if link.tcourl and link.url:
            text = text.replace(link.tcourl, link.url)
    return html.unescape(TCO.sub("", text)).strip()  # what's left is media and quote links


def media(tweet) -> list[dict]:
    items = [{"type": "photo", "url": p.url} for p in tweet.media.photos]
    for video in tweet.media.videos:
        mp4s = [v for v in video.variants if v.contentType == "video/mp4"]
        fitting = [v for v in mp4s if v.bitrate <= MAX_VIDEO_BITRATE] or mp4s
        if fitting:
            best = max(fitting, key=lambda v: v.bitrate)
            items.append({"type": "video", "url": best.url, "poster": video.thumbnailUrl})
    for gif in tweet.media.animated:
        items.append({"type": "gif", "url": gif.videoUrl, "poster": gif.thumbnailUrl})
    return items


def author(tweet) -> dict:
    user = tweet.user
    return {"handle": user.username, "name": user.displayname, "avatar": avatar(user.profileImageUrl)}


def embedded(tweet) -> dict:
    """A post shown inside another: a quote, a repost, or the post being replied to."""
    return {
        "id": str(tweet.id),
        "url": tweet.url,
        "at": int(tweet.date.timestamp()),
        "author": author(tweet),
        "text": clean_text(tweet),
        "media": media(tweet),
    }


def post(tweet, batch: dict[int, object]) -> dict:
    """`batch` maps id to tweet for everything in the same response. Timelines carry
    the parent of each reply, so it can be shown without another request."""
    source = tweet.retweetedTweet or tweet
    data = {
        "id": str(tweet.id),
        "url": tweet.url,
        "at": int(tweet.date.timestamp()),
        "kind": "repost" if tweet.retweetedTweet else "reply" if tweet.inReplyToTweetId else "post",
        "text": "" if tweet.retweetedTweet else clean_text(tweet),
        "media": [] if tweet.retweetedTweet else media(tweet),
    }
    if tweet.retweetedTweet:
        data["repost"] = embedded(tweet.retweetedTweet)
    if source.quotedTweet:
        data["quote"] = embedded(source.quotedTweet)
    if tweet.inReplyToTweetId:
        handle = tweet.inReplyToScreenName or getattr(tweet.inReplyToUser, "username", None)
        data["reply_to"] = {"handle": handle}
        parent = batch.get(tweet.inReplyToTweetId)
        if parent is not None:
            data["reply_to"]["post"] = embedded(parent)
    return data
