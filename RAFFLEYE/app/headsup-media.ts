import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Attachment } from 'discord.js';
import type { HeadsUp } from './headsups.js';
import { SafeError } from './log.js';
import type { PostScreenshots } from './screenshots.js';

export function publicPostId(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeError('Paste a published X post URL.'); }
  const match = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,30})(?:\/)?$/.exec(url.pathname);
  if(url.protocol!=='https:' || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port || !match) throw new SafeError('Paste a published X post URL.');
  return match[1]!;
}
export function imageExtension(bytes: Buffer): string {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'jpg';
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())) return 'gif';
  if(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') return 'webp';
  throw new SafeError('Upload a PNG, JPG, GIF or WebP image.');
}
export async function prepareHeadsUpImage(upload: Attachment | undefined, postUrl: string, dbPath: string, screenshots: PostScreenshots, signal: AbortSignal): Promise<NonNullable<HeadsUp['image']>> {
  if(Boolean(upload)===Boolean(postUrl)) throw new SafeError('Choose one uploaded image OR one published X post URL.');
  if(postUrl) {
    const id=publicPostId(postUrl), path=await screenshots.getById(id);
    if(!path) throw new SafeError('X could not render this post. Scheduled posts must be published first. Try uploading a prize picture instead.');
    return {path:resolve(path),name:'headsup-post-'+id+'.png',source:'https://x.com/i/web/status/'+id};
  }
  const file=upload!;
  if(file.size>8000000) throw new SafeError('Choose an image smaller than 8 MB.');
  const url=new URL(file.url);
  if(url.protocol!=='https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname) || !url.pathname.startsWith('/attachments/') || url.port || url.username || url.password) throw new SafeError('Upload the picture using the image picker.');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if(!response.ok || !response.body) throw new SafeError('The image could not be downloaded. Upload it again.');
  const chunks: Uint8Array[]=[];let size=0;
  const reader=response.body.getReader();
  try { while(true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8000000) {await reader.cancel();throw new SafeError('Choose an image smaller than 8 MB.');}chunks.push(value);} } finally {reader.releaseLock();}
  const bytes=Buffer.concat(chunks),extension=imageExtension(bytes),name='headsup-'+randomBytes(12).toString('hex')+'.'+extension;
  const directory=resolve(dirname(dbPath),'headsup-images');await mkdir(directory,{recursive:true});
  const path=join(directory,name);await writeFile(path,bytes,{flag:'wx'});return {path,name};
}
