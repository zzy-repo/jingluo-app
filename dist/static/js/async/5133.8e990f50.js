"use strict";(globalThis.rspackChunkdeepseek_app=globalThis.rspackChunkdeepseek_app||[]).push([[5133],{4855(t,e,a){function r(t,e){var a,r,l;t.accDescr&&(null==(a=e.setAccDescription)||a.call(e,t.accDescr)),t.accTitle&&(null==(r=e.setAccTitle)||r.call(e,t.accTitle)),t.title&&(null==(l=e.setDiagramTitle)||l.call(e,t.title))}a.d(e,{S:()=>r}),(0,a(9592).K2)(r,"populateCommonDb")},5324(t,e,a){a.d(e,{diagram:()=>g});var r=a(4855),l=a(8907),i=a(8617),o=a(9592),s=a(8410),n=o.UI.packet,c=class{constructor(){this.packet=[],this.setAccTitle=o.SV,this.getAccTitle=o.iN,this.setDiagramTitle=o.ke,this.getDiagramTitle=o.ab,this.getAccDescription=o.m7,this.setAccDescription=o.EI}static #t=(0,o.K2)(this,"PacketDB");getConfig(){let t=(0,l.$t)({...n,...(0,o.zj)().packet});return t.showBits&&(t.paddingY+=10),t}getPacket(){return this.packet}pushWord(t){t.length>0&&this.packet.push(t)}clear(){(0,o.IU)(),this.packet=[]}},d=(0,o.K2)((t,e)=>{(0,r.S)(t,e);let a=-1,l=[],i=1,{bitsPerRow:s}=e.getConfig();for(let{start:r,end:n,bits:c,label:d}of t.blocks){if(void 0!==r&&void 0!==n&&n<r)throw Error(`Packet block ${r} - ${n} is invalid. End must be greater than start.`);if(r??(r=a+1),r!==a+1)throw Error(`Packet block ${r} - ${n??r} is not contiguous. It should start from ${a+1}.`);if(0===c)throw Error(`Packet block ${r} is invalid. Cannot have a zero bit field.`);for(n??(n=r+(c??1)-1),c??(c=n-r+1),a=n,o.Rm.debug(`Packet block ${r} - ${a} with label ${d}`);l.length<=s+1&&e.getPacket().length<1e4;){let[t,a]=p({start:r,end:n,bits:c,label:d},i,s);if(l.push(t),t.end+1===i*s&&(e.pushWord(l),l=[],i++),!a)break;({start:r,end:n,bits:c,label:d}=a)}}e.pushWord(l)},"populate"),p=(0,o.K2)((t,e,a)=>{if(void 0===t.start)throw Error("start should have been set during first phase");if(void 0===t.end)throw Error("end should have been set during first phase");if(t.start>t.end)throw Error(`Block start ${t.start} is greater than block end ${t.end}.`);if(t.end+1<=e*a)return[t,void 0];let r=e*a-1,l=e*a;return[{start:t.start,end:r,label:t.label,bits:r-t.start},{start:l,end:t.end,label:t.label,bits:t.end-l}]},"getNextFittingBlock"),k={parser:{yy:void 0},parse:(0,o.K2)(async t=>{var e;let a=await (0,s.qg)("packet",t),r=null==(e=k.parser)?void 0:e.yy;if(!(r instanceof c))throw Error("parser.parser?.yy was not a PacketDB. This is due to a bug within Mermaid, please report this issue at https://github.com/mermaid-js/mermaid/issues.");o.Rm.debug(a),d(a,r)},"parse")},h=(0,o.K2)((t,e,a,r)=>{let l=r.db,s=l.getConfig(),{rowHeight:n,paddingY:c,bitWidth:d,bitsPerRow:p}=s,k=l.getPacket(),h=l.getDiagramTitle(),u=n+c,g=u*(k.length+1)-(h?0:n),f=d*p+2,m=(0,i.D)(e);for(let[t,e]of(m.attr("viewbox",`0 0 ${f} ${g}`),(0,o.a$)(m,g,f,s.useMaxWidth),k.entries()))b(m,e,t,s);m.append("text").text(h).attr("x",f/2).attr("y",g-u/2).attr("dominant-baseline","middle").attr("text-anchor","middle").attr("class","packetTitle")},"draw"),b=(0,o.K2)((t,e,a,r)=>{let{rowHeight:l,paddingX:i,paddingY:o,bitWidth:s,bitsPerRow:n,showBits:c}=r,d=t.append("g"),p=a*(l+o)+o;for(let t of e){let e=t.start%n*s+1,a=(t.end-t.start+1)*s-i;if(d.append("rect").attr("x",e).attr("y",p).attr("width",a).attr("height",l).attr("class","packetBlock"),d.append("text").attr("x",e+a/2).attr("y",p+l/2).attr("class","packetLabel").attr("dominant-baseline","middle").attr("text-anchor","middle").text(t.label),!c)continue;let r=t.end===t.start,o=p-2;d.append("text").attr("x",e+(r?a/2:0)).attr("y",o).attr("class","packetByte start").attr("dominant-baseline","auto").attr("text-anchor",r?"middle":"start").text(t.start),r||d.append("text").attr("x",e+a).attr("y",o).attr("class","packetByte end").attr("dominant-baseline","auto").attr("text-anchor","end").text(t.end)}},"drawWord"),u={byteFontSize:"10px",startByteColor:"black",endByteColor:"black",labelColor:"black",labelFontSize:"12px",titleColor:"black",titleFontSize:"14px",blockStrokeColor:"black",blockStrokeWidth:"1",blockFillColor:"#efefef"},g={parser:k,get db(){return new c},renderer:{draw:h},styles:(0,o.K2)(function(){let{packet:t}=arguments.length>0&&void 0!==arguments[0]?arguments[0]:{},e=(0,l.$t)(u,t);return`
	.packetByte {
		font-size: ${e.byteFontSize};
	}
	.packetByte.start {
		fill: ${e.startByteColor};
	}
	.packetByte.end {
		fill: ${e.endByteColor};
	}
	.packetLabel {
		fill: ${e.labelColor};
		font-size: ${e.labelFontSize};
	}
	.packetTitle {
		fill: ${e.titleColor};
		font-size: ${e.titleFontSize};
	}
	.packetBlock {
		stroke: ${e.blockStrokeColor};
		stroke-width: ${e.blockStrokeWidth};
		fill: ${e.blockFillColor};
	}
	`},"styles")}}}]);