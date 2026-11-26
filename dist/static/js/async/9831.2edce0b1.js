"use strict";(globalThis.rspackChunkdeepseek_app=globalThis.rspackChunkdeepseek_app||[]).push([[9831],{4855(t,e,a){function r(t,e){var a,r,i;t.accDescr&&(null==(a=e.setAccDescription)||a.call(e,t.accDescr)),t.accTitle&&(null==(r=e.setAccTitle)||r.call(e,t.accTitle)),t.title&&(null==(i=e.setDiagramTitle)||i.call(e,t.title))}a.d(e,{S:()=>r}),(0,a(9592).K2)(r,"populateCommonDb")},2426(t,e,a){a.d(e,{diagram:()=>D});var r=a(4855),i=a(8907),l=a(8617),n=a(9592),s=a(8410),o={showLegend:!0,ticks:5,max:null,min:0,graticule:"circle"},c={axes:[],curves:[],options:o},d=structuredClone(c),u=n.UI.radar,g=(0,n.K2)(()=>(0,i.$t)({...u,...(0,n.zj)().radar}),"getConfig"),h=(0,n.K2)(()=>d.axes,"getAxes"),p=(0,n.K2)(()=>d.curves,"getCurves"),x=(0,n.K2)(()=>d.options,"getOptions"),m=(0,n.K2)(t=>{d.axes=t.map(t=>({name:t.name,label:t.label??t.name}))},"setAxes"),$=(0,n.K2)(t=>{d.curves=t.map(t=>({name:t.name,label:t.label??t.name,entries:f(t.entries)}))},"setCurves"),f=(0,n.K2)(t=>{if(void 0==t[0].axis)return t.map(t=>t.value);let e=h();if(0===e.length)throw Error("Axes must be populated before curves for reference entries");return e.map(e=>{let a=t.find(t=>{var a;return(null==(a=t.axis)?void 0:a.$refText)===e.name});if(void 0===a)throw Error("Missing entry for axis "+e.label);return a.value})},"computeCurveEntries"),v={getAxes:h,getCurves:p,getOptions:x,setAxes:m,setCurves:$,setOptions:(0,n.K2)(t=>{var e,a,r,i,l;let n=t.reduce((t,e)=>(t[e.name]=e,t),{});d.options={showLegend:(null==(e=n.showLegend)?void 0:e.value)??o.showLegend,ticks:(null==(a=n.ticks)?void 0:a.value)??o.ticks,max:(null==(r=n.max)?void 0:r.value)??o.max,min:(null==(i=n.min)?void 0:i.value)??o.min,graticule:(null==(l=n.graticule)?void 0:l.value)??o.graticule}},"setOptions"),getConfig:g,clear:(0,n.K2)(()=>{(0,n.IU)(),d=structuredClone(c)},"clear"),setAccTitle:n.SV,getAccTitle:n.iN,setDiagramTitle:n.ke,getDiagramTitle:n.ab,getAccDescription:n.m7,setAccDescription:n.EI},y=(0,n.K2)(t=>{(0,r.S)(t,v);let{axes:e,curves:a,options:i}=t;v.setAxes(e),v.setCurves(a),v.setOptions(i)},"populate"),b={parse:(0,n.K2)(async t=>{let e=await (0,s.qg)("radar",t);n.Rm.debug(e),y(e)},"parse")},w=(0,n.K2)((t,e,a,r)=>{let i=r.db,n=i.getAxes(),s=i.getCurves(),o=i.getOptions(),c=i.getConfig(),d=i.getDiagramTitle(),u=C((0,l.D)(e),c),g=o.max??Math.max(...s.map(t=>Math.max(...t.entries))),h=o.min,p=Math.min(c.width,c.height)/2;M(u,n,p,o.ticks,o.graticule),K(u,n,p,c),T(u,n,s,h,g,o.graticule,c),A(u,s,o.showLegend,c),u.append("text").attr("class","radarTitle").text(d).attr("x",0).attr("y",-c.height/2-c.marginTop)},"draw"),C=(0,n.K2)((t,e)=>{let a=e.width+e.marginLeft+e.marginRight,r=e.height+e.marginTop+e.marginBottom,i={x:e.marginLeft+e.width/2,y:e.marginTop+e.height/2};return t.attr("viewbox",`0 0 ${a} ${r}`).attr("width",a).attr("height",r),t.append("g").attr("transform",`translate(${i.x}, ${i.y})`)},"drawFrame"),M=(0,n.K2)((t,e,a,r,i)=>{if("circle"===i)for(let e=0;e<r;e++){let i=a*(e+1)/r;t.append("circle").attr("r",i).attr("class","radarGraticule")}else if("polygon"===i){let i=e.length;for(let l=0;l<r;l++){let n=a*(l+1)/r,s=e.map((t,e)=>{let a=2*e*Math.PI/i-Math.PI/2,r=n*Math.cos(a),l=n*Math.sin(a);return`${r},${l}`}).join(" ");t.append("polygon").attr("points",s).attr("class","radarGraticule")}}},"drawGraticule"),K=(0,n.K2)((t,e,a,r)=>{let i=e.length;for(let l=0;l<i;l++){let n=e[l].label,s=2*l*Math.PI/i-Math.PI/2;t.append("line").attr("x1",0).attr("y1",0).attr("x2",a*r.axisScaleFactor*Math.cos(s)).attr("y2",a*r.axisScaleFactor*Math.sin(s)).attr("class","radarAxisLine"),t.append("text").text(n).attr("x",a*r.axisLabelFactor*Math.cos(s)).attr("y",a*r.axisLabelFactor*Math.sin(s)).attr("class","radarAxisLabel")}},"drawAxes");function T(t,e,a,r,i,l,n){let s=e.length,o=Math.min(n.width,n.height)/2;a.forEach((e,a)=>{if(e.entries.length!==s)return;let c=e.entries.map((t,e)=>{let a=2*Math.PI*e/s-Math.PI/2,l=k(t,r,i,o);return{x:l*Math.cos(a),y:l*Math.sin(a)}});"circle"===l?t.append("path").attr("d",L(c,n.curveTension)).attr("class",`radarCurve-${a}`):"polygon"===l&&t.append("polygon").attr("points",c.map(t=>`${t.x},${t.y}`).join(" ")).attr("class",`radarCurve-${a}`)})}function k(t,e,a,r){return r*(Math.min(Math.max(t,e),a)-e)/(a-e)}function L(t,e){let a=t.length,r=`M${t[0].x},${t[0].y}`;for(let i=0;i<a;i++){let l=t[(i-1+a)%a],n=t[i],s=t[(i+1)%a],o=t[(i+2)%a],c={x:n.x+(s.x-l.x)*e,y:n.y+(s.y-l.y)*e},d={x:s.x-(o.x-n.x)*e,y:s.y-(o.y-n.y)*e};r+=` C${c.x},${c.y} ${d.x},${d.y} ${s.x},${s.y}`}return`${r} Z`}function A(t,e,a,r){if(!a)return;let i=(r.width/2+r.marginRight)*3/4,l=-(3*(r.height/2+r.marginTop))/4;e.forEach((e,a)=>{let r=t.append("g").attr("transform",`translate(${i}, ${l+20*a})`);r.append("rect").attr("width",12).attr("height",12).attr("class",`radarLegendBox-${a}`),r.append("text").attr("x",16).attr("y",0).attr("class","radarLegendText").text(e.label)})}(0,n.K2)(T,"drawCurves"),(0,n.K2)(k,"relativeRadius"),(0,n.K2)(L,"closedRoundCurve"),(0,n.K2)(A,"drawLegend");var S=(0,n.K2)((t,e)=>{let a="";for(let r=0;r<t.THEME_COLOR_LIMIT;r++){let i=t[`cScale${r}`];a+=`
		.radarCurve-${r} {
			color: ${i};
			fill: ${i};
			fill-opacity: ${e.curveOpacity};
			stroke: ${i};
			stroke-width: ${e.curveStrokeWidth};
		}
		.radarLegendBox-${r} {
			fill: ${i};
			fill-opacity: ${e.curveOpacity};
			stroke: ${i};
		}
		`}return a},"genIndexStyles"),I=(0,n.K2)(t=>{let e=(0,n.P$)(),a=(0,n.zj)(),r=(0,i.$t)(e,a.themeVariables),l=(0,i.$t)(r.radar,t);return{themeVariables:r,radarOptions:l}},"buildRadarStyleOptions"),D={parser:b,db:v,renderer:{draw:w},styles:(0,n.K2)(function(){let{radar:t}=arguments.length>0&&void 0!==arguments[0]?arguments[0]:{},{themeVariables:e,radarOptions:a}=I(t);return`
	.radarTitle {
		font-size: ${e.fontSize};
		color: ${e.titleColor};
		dominant-baseline: hanging;
		text-anchor: middle;
	}
	.radarAxisLine {
		stroke: ${a.axisColor};
		stroke-width: ${a.axisStrokeWidth};
	}
	.radarAxisLabel {
		dominant-baseline: middle;
		text-anchor: middle;
		font-size: ${a.axisLabelFontSize}px;
		color: ${a.axisColor};
	}
	.radarGraticule {
		fill: ${a.graticuleColor};
		fill-opacity: ${a.graticuleOpacity};
		stroke: ${a.graticuleColor};
		stroke-width: ${a.graticuleStrokeWidth};
	}
	.radarLegendText {
		text-anchor: start;
		font-size: ${a.legendFontSize}px;
		dominant-baseline: hanging;
	}
	${S(e,a)}
	`},"styles")}}}]);