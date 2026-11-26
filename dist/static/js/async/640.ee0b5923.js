"use strict";(globalThis.rspackChunkdeepseek_app=globalThis.rspackChunkdeepseek_app||[]).push([[640],{4855(e,t,a){function i(e,t){var a,i,l;e.accDescr&&(null==(a=t.setAccDescription)||a.call(t,e.accDescr)),e.accTitle&&(null==(i=t.setAccTitle)||i.call(t,e.accTitle)),e.title&&(null==(l=t.setDiagramTitle)||l.call(t,e.title))}a.d(t,{S:()=>i}),(0,a(9592).K2)(i,"populateCommonDb")},5491(e,t,a){a.d(t,{diagram:()=>k});var i=a(4855),l=a(8907),r=a(8617),s=a(9592),n=a(8410),o=a(2631),c=a(1733),p=s.UI.pie,d={sections:new Map,showData:!1,config:p},u=d.sections,g=d.showData,h=structuredClone(p),f=(0,s.K2)(()=>structuredClone(h),"getConfig"),m=(0,s.K2)(()=>{u=new Map,g=d.showData,(0,s.IU)()},"clear"),x=(0,s.K2)(e=>{let{label:t,value:a}=e;if(a<0)throw Error(`"${t}" has invalid value: ${a}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);u.has(t)||(u.set(t,a),s.Rm.debug(`added new section: ${t}, with value: ${a}`))},"addSection"),S=(0,s.K2)(()=>u,"getSections"),w=(0,s.K2)(e=>{g=e},"setShowData"),T=(0,s.K2)(()=>g,"getShowData"),$={getConfig:f,clear:m,setDiagramTitle:s.ke,getDiagramTitle:s.ab,setAccTitle:s.SV,getAccTitle:s.iN,setAccDescription:s.EI,getAccDescription:s.m7,addSection:x,getSections:S,setShowData:w,getShowData:T},D=(0,s.K2)((e,t)=>{(0,i.S)(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},"populateDb"),v={parse:(0,s.K2)(async e=>{let t=await (0,n.qg)("pie",e);s.Rm.debug(t),D(t,$)},"parse")},y=(0,s.K2)(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,"getStyles"),C=(0,s.K2)(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),a=[...e.entries()].map(e=>{let[t,a]=e;return{label:t,value:a}}).filter(e=>e.value/t*100>=1).sort((e,t)=>t.value-e.value);return(0,o.rL)().value(e=>e.value)(a)},"createPieArcs"),k={parser:v,db:$,renderer:{draw:(0,s.K2)((e,t,a,i)=>{s.Rm.debug("rendering pie chart\n"+e);let n=i.db,p=(0,s.D7)(),d=(0,l.$t)(n.getConfig(),p.pie),u=(0,r.D)(t),g=u.append("g");g.attr("transform","translate(225,225)");let{themeVariables:h}=p,[f]=(0,l.I5)(h.pieOuterStrokeWidth);f??(f=2);let m=d.textPosition,x=(0,o.JL)().innerRadius(0).outerRadius(185),S=(0,o.JL)().innerRadius(185*m).outerRadius(185*m);g.append("circle").attr("cx",0).attr("cy",0).attr("r",185+f/2).attr("class","pieOuterCircle");let w=n.getSections(),T=C(w),$=[h.pie1,h.pie2,h.pie3,h.pie4,h.pie5,h.pie6,h.pie7,h.pie8,h.pie9,h.pie10,h.pie11,h.pie12],D=0;w.forEach(e=>{D+=e});let v=T.filter(e=>"0"!==(e.data.value/D*100).toFixed(0)),y=(0,c.UM)($);g.selectAll("mySlices").data(v).enter().append("path").attr("d",x).attr("fill",e=>y(e.data.label)).attr("class","pieCircle"),g.selectAll("mySlices").data(v).enter().append("text").text(e=>(e.data.value/D*100).toFixed(0)+"%").attr("transform",e=>"translate("+S.centroid(e)+")").style("text-anchor","middle").attr("class","slice"),g.append("text").text(n.getDiagramTitle()).attr("x",0).attr("y",-200).attr("class","pieTitleText");let k=[...w.entries()].map(e=>{let[t,a]=e;return{label:t,value:a}}),b=g.selectAll(".legend").data(k).enter().append("g").attr("class","legend").attr("transform",(e,t)=>"translate(216,"+(22*t-22*k.length/2)+")");b.append("rect").attr("width",18).attr("height",18).style("fill",e=>y(e.label)).style("stroke",e=>y(e.label)),b.append("text").attr("x",22).attr("y",14).text(e=>n.getShowData()?`${e.label} [${e.value}]`:e.label);let A=512+Math.max(...b.selectAll("text").nodes().map(e=>(null==e?void 0:e.getBoundingClientRect().width)??0));u.attr("viewBox",`0 0 ${A} 450`),(0,s.a$)(u,450,A,d.useMaxWidth)},"draw")},styles:y}}}]);