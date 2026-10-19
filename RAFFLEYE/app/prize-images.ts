import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { SafeError } from './log.js';

export const PRIZE_IMAGES = [
  {id:'lunite-pack',label:'Lunite'},
  {id:'lunite-subscription',label:'Lunite Subscription'},
  {id:'insider-channel',label:'Insider Channel'},
  {id:'connoisseur-channel',label:'Connoisseur Channel'},
] as const;
export function prizeImageChoices(kind:'heads'|'raffle',id:string) {
  const button=(action:string,label:string)=>new ButtonBuilder().setCustomId(`raffleye:${kind}:${action}:${id}`).setLabel(label).setStyle(ButtonStyle.Secondary);
  return {content:'**Choose a prize image**\nLDSHOP images: choose an icon below, or upload your own picture / capture a published X post. This changes the picture only; set the exact prize and quantity in your giveaway title.',embeds:[],components:[
    new ActionRowBuilder<ButtonBuilder>().addComponents(...PRIZE_IMAGES.map(item=>button('preset-'+item.id,item.label))),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button('upload','Upload / X post'),button('removeimage','Remove image')),
  ]};
}
export async function presetPrizeImage(id:string,dbPath:string) {
  if(!PRIZE_IMAGES.some(item=>item.id===id))throw new SafeError('Choose one of the available prize images.');
  const name=`catalog-${id}-v1.webp`,directory=resolve(dirname(dbPath),'headsup-images');
  await mkdir(directory,{recursive:true});
  const path=join(directory,name);
  await copyFile(fileURLToPath(new URL(`../assets/prizes/${id}.webp`,import.meta.url)),path);
  return {path,name,source:'https://www.ldshop.gg/blog/wuthering-waves/wuthering-waves-packs-guide.html'};
}
