---
name: youtube
description: Use this skill when the user wants to search YouTube, upload videos, manage their channel, post/delete comments, manage playlists, subscribe/unsubscribe, like videos, set thumbnails, manage captions, go live, get analytics, or do anything with YouTube.
---

# YouTube Control Guide

## Get YouTube service
```python
import sys; sys.path.insert(0, 'C:/Blopus')
from google_auth import get_service
yt = get_service('youtube', 'v3')
```

## Search videos
```python
def search_videos(query: str, max_results: int = 5):
    res = yt.search().list(q=query, part='snippet', type='video', maxResults=max_results).execute()
    return [{'id': i['id']['videoId'], 'title': i['snippet']['title'],
             'channel': i['snippet']['channelTitle'],
             'url': f"https://youtube.com/watch?v={i['id']['videoId']}"}
            for i in res.get('items', [])]
```

## Get my channel info + stats
```python
def get_my_channel():
    res = yt.channels().list(part='snippet,statistics,brandingSettings', mine=True).execute()
    ch = res['items'][0]
    return {
        'name': ch['snippet']['title'],
        'description': ch['snippet']['description'],
        'subscribers': ch['statistics'].get('subscriberCount', '0'),
        'views': ch['statistics'].get('viewCount', '0'),
        'videos': ch['statistics'].get('videoCount', '0'),
    }
```

## List my uploaded videos
```python
def get_my_videos(max_results: int = 10):
    ch = yt.channels().list(part='contentDetails', mine=True).execute()
    uploads_id = ch['items'][0]['contentDetails']['relatedPlaylists']['uploads']
    res = yt.playlistItems().list(playlistId=uploads_id, part='snippet', maxResults=max_results).execute()
    return [{'title': i['snippet']['title'],
             'id': i['snippet']['resourceId']['videoId'],
             'published': i['snippet']['publishedAt'],
             'url': f"https://youtube.com/watch?v={i['snippet']['resourceId']['videoId']}"}
            for i in res.get('items', [])]
```

## Upload a video
```python
from googleapiclient.http import MediaFileUpload

def upload_video(file_path: str, title: str, description: str, tags: list = [], category_id: str = '22'):
    # category_id 22 = People & Blogs, 28 = Science & Tech, 24 = Entertainment
    media = MediaFileUpload(file_path, chunksize=-1, resumable=True)
    body = {
        'snippet': {'title': title, 'description': description, 'tags': tags, 'categoryId': category_id},
        'status': {'privacyStatus': 'public'}  # or 'private', 'unlisted'
    }
    request = yt.videos().insert(part='snippet,status', body=body, media_body=media)
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"Uploading: {int(status.progress() * 100)}%")
    print(f"Upload complete: https://youtube.com/watch?v={response['id']}")
    return response
```

## Update video metadata (title, description, tags)
```python
def update_video(video_id: str, title: str = None, description: str = None, tags: list = None):
    res = yt.videos().list(part='snippet', id=video_id).execute()
    snippet = res['items'][0]['snippet']
    if title: snippet['title'] = title
    if description: snippet['description'] = description
    if tags: snippet['tags'] = tags
    yt.videos().update(part='snippet', body={'id': video_id, 'snippet': snippet}).execute()
    print(f"Video {video_id} updated")
```

## Delete a video
```python
def delete_video(video_id: str):
    yt.videos().delete(id=video_id).execute()
    print(f"Video {video_id} deleted")
```

## Set custom thumbnail
```python
from googleapiclient.http import MediaFileUpload

def set_thumbnail(video_id: str, image_path: str):
    media = MediaFileUpload(image_path, mimetype='image/jpeg')
    yt.thumbnails().set(videoId=video_id, media_body=media).execute()
    print(f"Thumbnail set for {video_id}")
```

## Like / dislike / remove rating
```python
def rate_video(video_id: str, rating: str = 'like'):
    # rating: 'like', 'dislike', 'none'
    yt.videos().rate(id=video_id, rating=rating).execute()
    print(f"Rated {video_id} as {rating}")
```

## Get comments on a video
```python
def get_comments(video_id: str, max_results: int = 20):
    res = yt.commentThreads().list(videoId=video_id, part='snippet', maxResults=max_results).execute()
    return [{'author': i['snippet']['topLevelComment']['snippet']['authorDisplayName'],
             'text': i['snippet']['topLevelComment']['snippet']['textDisplay'],
             'likes': i['snippet']['topLevelComment']['snippet']['likeCount'],
             'id': i['id']}
            for i in res.get('items', [])]
```

## Post a comment on a video
```python
def post_comment(video_id: str, text: str):
    res = yt.commentThreads().insert(
        part='snippet',
        body={'snippet': {'videoId': video_id, 'topLevelComment': {'snippet': {'textOriginal': text}}}}
    ).execute()
    print(f"Comment posted: {res['id']}")
    return res
```

## Reply to a comment
```python
def reply_to_comment(parent_id: str, text: str):
    res = yt.comments().insert(
        part='snippet',
        body={'snippet': {'parentId': parent_id, 'textOriginal': text}}
    ).execute()
    print(f"Reply posted: {res['id']}")
```

## Delete a comment
```python
def delete_comment(comment_id: str):
    yt.comments().delete(id=comment_id).execute()
    print(f"Comment {comment_id} deleted")
```

## Moderate comments (approve / hold / reject)
```python
def moderate_comment(comment_id: str, status: str = 'published'):
    # status: 'published', 'heldForReview', 'rejected'
    yt.comments().setModerationStatus(id=comment_id, moderationStatus=status).execute()
```

## Create a playlist
```python
def create_playlist(title: str, description: str = '', privacy: str = 'public'):
    res = yt.playlists().insert(
        part='snippet,status',
        body={'snippet': {'title': title, 'description': description},
              'status': {'privacyStatus': privacy}}
    ).execute()
    print(f"Playlist created: {res['id']}")
    return res
```

## Add video to playlist
```python
def add_to_playlist(playlist_id: str, video_id: str):
    yt.playlistItems().insert(
        part='snippet',
        body={'snippet': {'playlistId': playlist_id, 'resourceId': {'kind': 'youtube#video', 'videoId': video_id}}}
    ).execute()
    print(f"Added {video_id} to playlist {playlist_id}")
```

## Remove video from playlist
```python
def remove_from_playlist(playlist_item_id: str):
    yt.playlistItems().delete(id=playlist_item_id).execute()
```

## Subscribe to a channel
```python
def subscribe(channel_id: str):
    yt.subscriptions().insert(
        part='snippet',
        body={'snippet': {'resourceId': {'kind': 'youtube#channel', 'channelId': channel_id}}}
    ).execute()
    print(f"Subscribed to {channel_id}")
```

## Unsubscribe from a channel
```python
def unsubscribe(subscription_id: str):
    yt.subscriptions().delete(id=subscription_id).execute()
```

## List my subscriptions
```python
def list_subscriptions(max_results: int = 20):
    res = yt.subscriptions().list(part='snippet', mine=True, maxResults=max_results).execute()
    return [{'channel': i['snippet']['title'], 'id': i['snippet']['resourceId']['channelId']}
            for i in res.get('items', [])]
```

## List channel members
```python
def list_members():
    res = yt.members().list(part='snippet', mode='listMembers').execute()
    return [{'name': i['snippet']['memberDetails']['displayName'],
             'level': i['snippet']['membershipsDetails']['highestActiveLevel'].get('displayName', '')}
            for i in res.get('items', [])]
```

## Upload channel banner
```python
from googleapiclient.http import MediaFileUpload

def set_channel_banner(image_path: str):
    media = MediaFileUpload(image_path, mimetype='image/jpeg')
    res = yt.channelBanners().insert(media_body=media, part='snippet').execute()
    # Then update channel with the returned banner URL
    print(f"Banner URL: {res['url']}")
```

## Update a playlist
```python
def update_playlist(playlist_id: str, title: str = None, description: str = None, privacy: str = None):
    res = yt.playlists().list(part='snippet,status', id=playlist_id).execute()
    item = res['items'][0]
    if title: item['snippet']['title'] = title
    if description: item['snippet']['description'] = description
    if privacy: item['status']['privacyStatus'] = privacy
    yt.playlists().update(part='snippet,status', body=item).execute()
    print(f"Playlist {playlist_id} updated")
```

## Delete a playlist
```python
def delete_playlist(playlist_id: str):
    yt.playlists().delete(id=playlist_id).execute()
    print(f"Playlist {playlist_id} deleted")
```

## List items in a playlist
```python
def list_playlist_items(playlist_id: str, max_results: int = 50):
    res = yt.playlistItems().list(playlistId=playlist_id, part='snippet', maxResults=max_results).execute()
    return [{'title': i['snippet']['title'],
             'videoId': i['snippet']['resourceId']['videoId'],
             'position': i['snippet']['position'],
             'itemId': i['id']}
            for i in res.get('items', [])]
```

## Reorder item in playlist
```python
def reorder_playlist_item(playlist_id: str, item_id: str, video_id: str, new_position: int):
    yt.playlistItems().update(
        part='snippet',
        body={'id': item_id, 'snippet': {
            'playlistId': playlist_id,
            'resourceId': {'kind': 'youtube#video', 'videoId': video_id},
            'position': new_position
        }}
    ).execute()
```

## Set playlist thumbnail image
```python
from googleapiclient.http import MediaFileUpload

def set_playlist_thumbnail(playlist_id: str, image_path: str):
    media = MediaFileUpload(image_path, mimetype='image/jpeg')
    yt.playlistImages().insert(
        part='id,snippet',
        body={'snippet': {'playlistId': playlist_id, 'type': 'custom'}},
        media_body=media
    ).execute()
    print(f"Playlist thumbnail set")
```

## Remove channel watermark
```python
def remove_watermark(channel_id: str):
    yt.watermarks().unset(channelId=channel_id).execute()
    print("Watermark removed")
```

## Captions — list, upload, download, delete
```python
# List captions for a video
def list_captions(video_id: str):
    res = yt.captions().list(part='snippet', videoId=video_id).execute()
    return [{'id': c['id'], 'language': c['snippet']['language'],
             'name': c['snippet']['name'], 'trackKind': c['snippet']['trackKind']}
            for c in res.get('items', [])]

# Upload a caption file (.srt or .vtt)
def upload_caption(video_id: str, language: str, name: str, file_path: str):
    from googleapiclient.http import MediaFileUpload
    media = MediaFileUpload(file_path, mimetype='application/octet-stream', resumable=True)
    yt.captions().insert(
        part='snippet',
        body={'snippet': {'videoId': video_id, 'language': language, 'name': name, 'isDraft': False}},
        media_body=media
    ).execute()
    print(f"Caption uploaded for {video_id}")

# Download a caption track
def download_caption(caption_id: str, fmt: str = 'srt') -> bytes:
    # fmt: 'srt', 'vtt', 'ttml', 'sbv'
    return yt.captions().download(id=caption_id, tfmt=fmt).execute()

# Delete a caption track
def delete_caption(caption_id: str):
    yt.captions().delete(id=caption_id).execute()
    print(f"Caption {caption_id} deleted")
```

## Live Streaming
```python
from datetime import datetime, timezone

# Create a live broadcast
def create_broadcast(title: str, scheduled_start: str, privacy: str = 'public'):
    # scheduled_start: ISO format e.g. '2026-04-15T18:00:00Z'
    res = yt.liveBroadcasts().insert(
        part='snippet,status,contentDetails',
        body={
            'snippet': {'title': title, 'scheduledStartTime': scheduled_start},
            'status': {'privacyStatus': privacy},
            'contentDetails': {'enableAutoStart': True, 'enableAutoStop': True}
        }
    ).execute()
    print(f"Broadcast created: {res['id']}")
    return res

# Create a live stream (ingestion point)
def create_live_stream(title: str):
    res = yt.liveStreams().insert(
        part='snippet,cdn',
        body={
            'snippet': {'title': title},
            'cdn': {'frameRate': '30fps', 'ingestionType': 'rtmp', 'resolution': '1080p'}
        }
    ).execute()
    stream_key = res['cdn']['ingestionInfo']['streamName']
    rtmp_url = res['cdn']['ingestionInfo']['ingestionAddress']
    print(f"Stream key: {stream_key}")
    print(f"RTMP URL: {rtmp_url}")
    return res

# Bind broadcast to stream
def bind_broadcast(broadcast_id: str, stream_id: str):
    yt.liveBroadcasts().bind(
        part='id,contentDetails', id=broadcast_id, streamId=stream_id
    ).execute()
    print(f"Broadcast {broadcast_id} bound to stream {stream_id}")

# Transition broadcast status
def go_live(broadcast_id: str):
    # status: 'testing', 'live', 'complete'
    yt.liveBroadcasts().transition(
        broadcastStatus='live', id=broadcast_id, part='status'
    ).execute()
    print(f"Broadcast {broadcast_id} is now LIVE")

def end_broadcast(broadcast_id: str):
    yt.liveBroadcasts().transition(
        broadcastStatus='complete', id=broadcast_id, part='status'
    ).execute()
    print(f"Broadcast {broadcast_id} ended")

# List upcoming/active broadcasts
def list_broadcasts(broadcast_status: str = 'upcoming'):
    # broadcast_status: 'upcoming', 'active', 'completed', 'all'
    res = yt.liveBroadcasts().list(
        part='snippet,status', broadcastStatus=broadcast_status
    ).execute()
    return [{'id': b['id'], 'title': b['snippet']['title'],
             'start': b['snippet']['scheduledStartTime'],
             'status': b['status']['lifeCycleStatus']}
            for b in res.get('items', [])]
```

## YouTube Analytics

```python
import sys; sys.path.insert(0, 'C:/Blopus')
from google_auth import get_service
analytics = get_service('youtubeAnalytics', 'v2')
```

## Get channel views, watch time, subscribers (date range)
```python
from datetime import datetime, timedelta

def get_channel_stats(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE',
        startDate=start,
        endDate=end,
        metrics='views,estimatedMinutesWatched,subscribers,likes,comments',
        dimensions='day'
    ).execute()
    return res.get('rows', [])

rows = get_channel_stats(28)
for row in rows:
    print(f"Date: {row[0]} | Views: {row[1]} | Watch time (mins): {row[2]} | Subs gained: {row[3]}")
```

## Get top performing videos by views
```python
def get_top_videos(days: int = 28, max_results: int = 10):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE',
        startDate=start,
        endDate=end,
        metrics='views,estimatedMinutesWatched,averageViewDuration,likes,comments',
        dimensions='video',
        sort='-views',
        maxResults=max_results
    ).execute()
    return res.get('rows', [])

for v in get_top_videos():
    print(f"VideoID: {v[0]} | Views: {v[1]} | Watch time: {v[2]} | Avg duration: {v[3]}s")
```

## Get traffic sources (how viewers find your videos)
```python
def get_traffic_sources(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE',
        startDate=start,
        endDate=end,
        metrics='views',
        dimensions='insightTrafficSourceType',
        sort='-views'
    ).execute()
    return res.get('rows', [])

for row in get_traffic_sources():
    print(f"Source: {row[0]} | Views: {row[1]}")
```

## Get audience demographics (age + gender)
```python
def get_demographics(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE',
        startDate=start,
        endDate=end,
        metrics='viewerPercentage',
        dimensions='ageGroup,gender'
    ).execute()
    return res.get('rows', [])

for row in get_demographics():
    print(f"Age: {row[0]} | Gender: {row[1]} | %: {row[2]}")
```

## Get views by country
```python
def get_views_by_country(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE',
        startDate=start,
        endDate=end,
        metrics='views',
        dimensions='country',
        sort='-views',
        maxResults=10
    ).execute()
    return res.get('rows', [])
```

## Get subscriber gain/loss per day
```python
def get_subscriber_trend(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE',
        startDate=start,
        endDate=end,
        metrics='subscribersGained,subscribersLost',
        dimensions='day'
    ).execute()
    return res.get('rows', [])
```

## Get views by device type (mobile, desktop, tablet, TV)
```python
def get_views_by_device(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE', startDate=start, endDate=end,
        metrics='views', dimensions='deviceType', sort='-views'
    ).execute()
    return res.get('rows', [])
```

## Get views by playback location (YouTube watch page, embedded, etc.)
```python
def get_playback_locations(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE', startDate=start, endDate=end,
        metrics='views,estimatedMinutesWatched',
        dimensions='insightPlaybackLocationType', sort='-views'
    ).execute()
    return res.get('rows', [])
```

## Get audience retention for a specific video
```python
def get_audience_retention(video_id: str):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=90)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids=f'channel==MINE', startDate=start, endDate=end,
        metrics='audienceWatchRatio,relativeRetentionPerformance',
        dimensions='elapsedVideoTimeRatio',
        filters=f'video=={video_id}'
    ).execute()
    return res.get('rows', [])
```

## Get monthly performance summary
```python
def get_monthly_stats(months: int = 6):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=months*30)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE', startDate=start, endDate=end,
        metrics='views,estimatedMinutesWatched,subscribersGained,likes,comments',
        dimensions='month', sort='month'
    ).execute()
    return res.get('rows', [])
```

## Get revenue analytics (only if monetized)
```python
def get_revenue(days: int = 28):
    end = datetime.today().strftime('%Y-%m-%d')
    start = (datetime.today() - timedelta(days=days)).strftime('%Y-%m-%d')
    res = analytics.reports().query(
        ids='channel==MINE', startDate=start, endDate=end,
        metrics='estimatedAdRevenue,grossRevenue,cpm,adImpressions,monetizedPlaybacks',
        dimensions='day'
    ).execute()
    return res.get('rows', [])
```

Install: `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client`
