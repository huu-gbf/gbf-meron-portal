"""
YouTube Channel Adapter (RSS)
"""
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

def fetch(site_config: dict) -> list[dict]:
    channel_id = site_config.get("channel_id")
    if not channel_id:
        raise ValueError("channel_id is required in site_config")
    
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (GBF Crew Portal)'})
    
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            xml_data = response.read()
    except Exception as e:
        raise RuntimeError(f"Failed to fetch YouTube RSS: {e}")
    
    try:
        root = ET.fromstring(xml_data)
    except Exception as e:
        raise RuntimeError(f"Failed to parse XML: {e}")
        
    ns = {
        'yt': 'http://www.youtube.com/xml/schemas/2015', 
        'atom': 'http://www.w3.org/2005/Atom', 
        'media': 'http://search.yahoo.com/mrss/'
    }
    
    channel_name_elem = root.find('atom:author/atom:name', ns)
    channel_name = channel_name_elem.text if channel_name_elem is not None else site_config.get("name", "YouTube")
    
    entries = root.findall('atom:entry', ns)
    
    max_items = site_config.get("max_items", 20)
    
    articles = []
    for entry in entries[:max_items]:
        video_id_elem = entry.find('yt:videoId', ns)
        if video_id_elem is None or not video_id_elem.text:
            continue
        video_id = video_id_elem.text
        
        title_elem = entry.find('atom:title', ns)
        title = title_elem.text if title_elem is not None else "No Title"
        
        published_elem = entry.find('atom:published', ns)
        published_at = published_elem.text if published_elem is not None else ""
        
        article = {
            "source_id": site_config["id"],
            "source_name": channel_name,
            "source_type": site_config.get("source_type", "youtube_creator"),
            "title": title,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "published_at": published_at,
            "article_id": video_id,
            "video_id": video_id,
            "channel_id": channel_id
        }
        articles.append(article)
        
    return articles
