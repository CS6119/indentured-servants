import {expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Attachment} from 'discord.js';
import {imageExtension,publicPostId,prepareHeadsUpImage} from '../app/headsup-media.js';
import type {PostScreenshots} from '../app/screenshots.js';
import {PRIZE_IMAGES,presetPrizeImage,prizeImageChoices} from '../app/prize-images.js';
const screenshot=()=>({getById:vi.fn(async()=>'/cached/post.png')});
const signal=new AbortController().signal;
it('provides all four sourced prize images as durable local attachments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'prize-catalog-'));
 try {
 for(const preset of PRIZE_IMAGES) {
  const image=await presetPrizeImage(preset.id,join(dir,'test.db'));
  expect(imageExtension(await readFile(image.path))).toBe('webp');
  expect(image.source).toContain('ldshop.gg');
 }
 expect(prizeImageChoices('heads','id').components[0]!.toJSON().components).toHaveLength(4);
 await expect(presetPrizeImage('../secret',join(dir,'test.db'))).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('accepts only public X status URLs',()=>{
 expect(publicPostId('https://x.com/host/status/123?s=20')).toBe('123');
 expect(publicPostId('https://x.com/i/web/status/123')).toBe('123');
 for(const url of ['https://x.com.evil.test/host/status/123','https://localhost/host/status/123','http://x.com/host/status/123','https://x.com/compose/post']) expect(()=>publicPostId(url)).toThrow();
});
it('uses the official screenshot provider and reports unavailable posts',async()=>{
 const mock=screenshot();
 expect(await prepareHeadsUpImage(undefined,'https://x.com/host/status/123','test.db',mock as unknown as PostScreenshots,signal)).toMatchObject({name:'headsup-post-123.png',source:'https://x.com/i/web/status/123'});
 expect(mock.getById).toHaveBeenCalledWith('123');
 await expect(prepareHeadsUpImage(undefined,'https://x.com/host/status/123','test.db',{getById:async()=>null} as unknown as PostScreenshots,signal)).rejects.toThrow('Scheduled posts must be published');
});
it('downloads and persists a Discord image, rejects arbitrary hosts and oversized uploads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'headsup-media-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
 const upload={url:'https://cdn.discordapp.com/attachments/1/2/prize.png',size:png.length} as Attachment;
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(png));
 try {
 const image=await prepareHeadsUpImage(upload,'',join(dir,'test.db'),screenshot() as unknown as PostScreenshots,signal);
 expect(await readFile(image.path)).toEqual(png);expect(imageExtension(png)).toBe('png');
 expect(()=>imageExtension(Buffer.from('<html>not image</html>'))).toThrow();
 await expect(prepareHeadsUpImage({...upload,url:'https://localhost/a'} as Attachment,'',join(dir,'test.db'),screenshot() as unknown as PostScreenshots,signal)).rejects.toThrow('image picker');
 await expect(prepareHeadsUpImage({...upload,size:8000001} as Attachment,'',join(dir,'test.db'),screenshot() as unknown as PostScreenshots,signal)).rejects.toThrow('8 MB');
 await expect(prepareHeadsUpImage(upload,'https://x.com/host/status/123',join(dir,'test.db'),screenshot() as unknown as PostScreenshots,signal)).rejects.toThrow('one uploaded image');
 expect(fetchMock).toHaveBeenCalledOnce();
 } finally {fetchMock.mockRestore();await rm(dir,{recursive:true,force:true});}
});
