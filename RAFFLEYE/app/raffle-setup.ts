import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { PRIZE_IMAGES, presetPrizeImage } from './prize-images.js';
import { raffleButton, raffleEmbed } from './raffles.js';
import type { Raffle } from './raffles.js';
import { headsUpFiles } from './headsups.js';
import { explicitTimes } from './timeparse.js';
import { SafeError } from './log.js';

export const PRIZE_CHOICES=[{id:'lunite-pack',label:'Lunite',name:'3,280 Lunite'},{id:'lunite-subscription',label:'Monthly Pass',name:'Lunite Subscription'},{id:'insider-channel',label:'Battle Pass',name:'Insider Channel'},{id:'connoisseur-channel',label:'Premium Battle Pass',name:'Connoisseur Channel'}] as const;
const row=(...buttons:ButtonBuilder[])=>new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
export function prizeTitle(kind:string,amount:number):string {
  const prize=PRIZE_IMAGES.find(item=>item.id===kind);
  if(!prize)throw new SafeError('Choose a prize from the gallery.');
  return kind==='lunite-pack'?`${amount.toLocaleString('en-US')} Lunite`:`${amount} × ${prize.label}`;
}
export async function prizeGallery(item:Raffle,dbPath:string) {
  const images=await Promise.all(PRIZE_IMAGES.map(prize=>presetPrizeImage(prize.id,dbPath)));
  return {content:'**1 · Choose your prize**\nChoose Lunite, Monthly Pass, Battle Pass or Premium Battle Pass. Next: prize name, quantity, then description. Scheduling comes afterward.',
    embeds:PRIZE_CHOICES.map((prize,i)=>new EmbedBuilder().setTitle(prize.label).setDescription(prize.name).setImage('attachment://'+images[i]!.name).setColor(0x7586fa)),
    files:images.map(image=>new AttachmentBuilder(image.path,{name:image.name})),attachments:[],components:[
      row(...PRIZE_CHOICES.map(prize=>raffleButton(`choose:${item.id}:${prize.id}`,prize.label,ButtonStyle.Primary))),
      row(raffleButton('details:'+item.id+':custom','Other prize'),raffleButton('configure:'+item.id,'Back')),
    ]};
}
export function setupPanel(item:Raffle,now=Date.now()) {
  const start=item.startAt??now+(item.startDelay??0)*60000,end=item.endAt??start+item.minutes*60000;
  return {content:`**Your giveaway · review before publishing**\n**${item.winnerCount??1} winner(s)** · **${item.prize} per winner**. Publish announces it now and pings Beggars; entries open at the start time. Times below use your Discord timezone.`,embeds:[raffleEmbed({...item,opened:start,ends:end},0)],files:headsUpFiles(item),attachments:[],components:[
    row(raffleButton('gallery:'+item.id,'🎁 Prize'),raffleButton(`details:${item.id}:${item.prizeKind??'custom'}`,'Name, quantity & description'),raffleButton('starts:'+item.id,'🕒 Starts'),raffleButton('ends:'+item.id,'🏁 Ends')),
    row(raffleButton('publish:'+item.id,'Publish giveaway',ButtonStyle.Success).setDisabled(item.detailsReady===false),raffleButton('image:'+item.id,'Image'),raffleButton('cancel:'+item.id,'Discard',ButtonStyle.Danger)),
  ]};
}
export function prizeDetailsModal(item:Raffle,kind:string):ModalBuilder {
  const choice=PRIZE_CHOICES.find(prize=>prize.id===kind);if(!choice&&kind!=='custom')throw new SafeError('Choose a prize from the gallery.');
  const same=item.detailsReady!==false&&item.prizeKind===kind;
  const fields:[string,string,string,number,boolean][]=[
    ['name','Prize name / amount per winner',same?item.prize:(choice?.name??''),150,true],
    ['quantity','Quantity / winners (one prize per winner)',String(item.winnerCount??1),2,true],
    ['description','Description',item.rules,1000,false],
  ];
  const modal=new ModalBuilder().setCustomId(`raffleye:raffle:setup-details:${item.id}:${kind}`).setTitle(choice?.label??'Other prize');
  for(const [id,label,value,max,required] of fields){const input=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(id==='description'?TextInputStyle.Paragraph:TextInputStyle.Short).setMaxLength(max).setRequired(required);if(value)input.setValue(value);modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));}
  return modal;
}
export function setupChoices(item:Raffle,kind:'amount'|'starts'|'ends') {
  const options=kind==='amount'?(item.prizeKind==='lunite-pack'?[['60','60'],['300','300'],['980','980'],['1980','1,980'],['3280','3,280'],['6480','6,480']]:[['1','1'],['2','2'],['3','3'],['5','5'],['10','10']]):kind==='starts'?[['0','Now'],['5','In 5 min'],['15','In 15 min'],['60','In 1 hour'],['480','In 8 hours'],['1440','In 24 hours']]:[['25','25 min'],['30','30 min'],['60','1 hour'],['360','6 hours'],['720','12 hours'],['1440','24 hours'],['4320','3 days'],['10080','7 days']];
  const buttons=options.map(([value,label])=>raffleButton(`set-${kind}:${item.id}:${value!}`,label!,ButtonStyle.Primary));
  return {content:kind==='amount'?`**2 · How much?**\n${item.prizeKind==='lunite-pack'?'Total Lunite':'Number of items'} for one winner. These are prize quantities, not purchase prices.`:kind==='starts'?'**3 · When do entries open?**\nDelays are measured from publishing. The selected duration is preserved.':'**4 · When does it end?**\nChoose how long entries stay open, measured from the start. Or set exact dates with Custom time.',embeds:[],files:[],attachments:[],components:[row(...buttons.slice(0,5)),row(...buttons.slice(5),raffleButton((kind==='amount'?'quantity:':'schedule:')+item.id,kind==='amount'?'Custom amount':'Custom time'),raffleButton('configure:'+item.id,'Back to preview'))]};
}
export function setupModal(item:Raffle,kind:'custom'|'quantity'|'schedule') {
  const fields:[string,string,string,number,boolean][] = kind==='quantity'?[['quantity','Amount / number of items',String(item.quantity??1),6,true]]:kind==='schedule'?[
    ['start','Start: now, in 15m, or YYYY-MM-DD HH:mm',item.startAt?new Date(item.startAt).toISOString().slice(0,16).replace('T',' ')+' UTC':item.startDelay?`in ${item.startDelay}m`:'now',80,true],
    ['end','End: duration (e.g. 2h) or date and time',item.endAt?new Date(item.endAt).toISOString().slice(0,16).replace('T',' ')+' UTC':`${item.minutes}m`,80,true],
  ]:[['prize','Prize / amount shown on the card',item.prize,150,true],['rules','Prize details (optional)',item.rules,1000,false]];
  const modal=new ModalBuilder().setCustomId(`raffleye:raffle:setup-${kind}:${item.id}`).setTitle(kind==='schedule'?'Schedule · plain dates use Taipei':kind==='quantity'?'Prize amount':'Prize details');
  for(const [id,label,value,max,required] of fields){const input=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(id==='rules'?TextInputStyle.Paragraph:TextInputStyle.Short).setMaxLength(max).setRequired(required);if(value)input.setValue(value);modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));}
  return modal;
}
function exactTime(text:string):number {
  if(/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(text))text+=' UTC+8';
  const matches=explicitTimes(text);if(matches.length!==1)throw new SafeError('Use YYYY-MM-DD HH:mm (Taipei / UTC+8), or include a timezone such as UTC.');
  return matches[0]!.epoch;
}
export function scheduleInput(startText:string,endText:string,now=Date.now()):Pick<Raffle,'startAt'|'startDelay'|'endAt'|'minutes'> {
  const start=startText.trim(),end=endText.trim(),delay=/^in (\d+)\s*m$/i.exec(start),duration=/^(\d+)\s*([mhd])$/i.exec(end);
  const startDelay=/^now$/i.test(start)?0:delay?Number(delay[1]):undefined;
  const startAt=startDelay===undefined?exactTime(start):undefined,epoch=startAt??now+startDelay!*60000;
  if(epoch<now||epoch>now+30*86400000)throw new SafeError('Start now or within the next 30 days.');
  const endAt=duration?undefined:exactTime(end),minutes=duration?Number(duration[1])*({m:1,h:60,d:1440}[duration[2]!.toLowerCase()]!):(endAt!-epoch)/60000;
  if(!Number.isFinite(minutes)||minutes<1||minutes>10080)throw new SafeError('End must be after the start, with a duration from 1 minute to 7 days.');
  return {startAt,startDelay,endAt,minutes};
}
