// Generated from the Core member channel. Run pnpm generate:contracts; do not edit.
// Standalone generator: ajv 8.20.0 (MIT).
// The MIT License (MIT)
//
// Copyright (c) 2015-2021 Evgeny Poberezkin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
"use strict";
export const validate = validate20;
export default validate20;
const schema31 = {"$defs":{"ConflictEvidence":{"description":"Values compared at the rejecting boundary, without user text or credentials.","oneOf":[{"additionalProperties":false,"properties":{"current":{"$ref":"#/$defs/ExecutionId"},"expected":{"$ref":"#/$defs/ExecutionId"},"kind":{"const":"source-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"translation-selection","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"type":"string"},"expected":{"type":"string"},"kind":{"const":"review-basis","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"review-decision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"review-check","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"review-waiver","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"source-fallback","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"type":"string"},"expected":{"type":"string"},"kind":{"const":"build-eligibility","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"type":"string"},"expected":{"type":"string"},"kind":{"const":"comparison-basis","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"term-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"context-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"source-snapshot","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"$ref":"#/$defs/Revision"},"expected":{"$ref":"#/$defs/Revision"},"kind":{"const":"content-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"}]},"ErrorCode":{"enum":["invalid-input","limit-exceeded","result-mismatch","output-invalid","dependency-conflict","cancelled","outcome-unknown","unauthorized","busy","storage-failed","corrupt-ledger"],"type":"string"},"ExecutionError":{"additionalProperties":false,"properties":{"code":{"$ref":"#/$defs/ErrorCode"},"conflict":{"anyOf":[{"$ref":"#/$defs/ConflictEvidence"},{"type":"null"}]},"itemIds":{"items":{"$ref":"#/$defs/ExecutionId"},"type":"array"},"stage":{"type":"string"}},"required":["code","stage","itemIds"],"type":"object"},"ExecutionId":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"},"MemberBody":{"oneOf":[{"additionalProperties":false,"properties":{"context":true,"contextVersion":{"type":"string"},"input":{"type":"string"},"kind":{"const":"start","type":"string"},"maxTurns":{"maximum":4294967295,"minimum":0,"type":"integer"},"memberId":{"$ref":"#/$defs/ExecutionId"},"profile":{"$ref":"#/$defs/MemberProfile"},"systemPrompt":{"type":"string"},"timeoutMs":{"maximum":4294967295,"minimum":0,"type":"integer"},"tools":{"items":{"$ref":"#/$defs/MemberTool"},"type":"array"},"workItemId":{"$ref":"#/$defs/ExecutionId"}},"required":["kind","memberId","workItemId","contextVersion","profile","systemPrompt","context","input","tools","maxTurns","timeoutMs"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"ready","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"call":{"$ref":"#/$defs/MemberCall"},"kind":{"const":"request","type":"string"},"request":{"maximum":4294967295,"minimum":0,"type":"integer"}},"required":["kind","request","call"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"reply","type":"string"},"reply":{"$ref":"#/$defs/MemberReply"},"request":{"maximum":4294967295,"minimum":0,"type":"integer"}},"required":["kind","request","reply"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"guide","type":"string"},"text":{"type":"string"}},"required":["kind","text"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"close","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"result","type":"string"},"messages":true,"turnLimitReached":{"type":"boolean"}},"required":["kind","messages","turnLimitReached"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"closed","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"code":{"type":"string"},"kind":{"const":"fault","type":"string"}},"required":["kind","code"],"type":"object"}]},"MemberCall":{"oneOf":[{"additionalProperties":false,"properties":{"messages":true,"method":{"const":"prepare","type":"string"}},"required":["method","messages"],"type":"object"},{"additionalProperties":false,"properties":{"body":{"type":"string"},"endpoint":{"type":"string"},"method":{"const":"http","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"}},"required":["method","requestId","endpoint","body"],"type":"object"},{"additionalProperties":false,"properties":{"arguments":true,"callId":{"type":"string"},"method":{"const":"before-tool","type":"string"},"name":{"type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"}},"required":["method","requestId","callId","name","arguments"],"type":"object"},{"additionalProperties":false,"properties":{"arguments":true,"callId":{"type":"string"},"method":{"const":"execute-tool","type":"string"},"name":{"type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"}},"required":["method","requestId","callId","name","arguments"],"type":"object"},{"additionalProperties":false,"properties":{"callId":{"type":"string"},"isError":{"type":"boolean"},"method":{"const":"after-tool","type":"string"},"name":{"type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"result":true},"required":["method","requestId","callId","name","result","isError"],"type":"object"},{"additionalProperties":false,"properties":{"method":{"const":"finish-turn","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"stopReason":{"type":"string"}},"required":["method","requestId","stopReason"],"type":"object"},{"additionalProperties":false,"properties":{"event":true,"method":{"const":"event","type":"string"},"requestId":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]}},"required":["method","requestId","event"],"type":"object"},{"additionalProperties":false,"properties":{"method":{"const":"usage","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"usage":{"anyOf":[{"$ref":"#/$defs/Usage"},{"type":"null"}]}},"required":["method","requestId","usage"],"type":"object"}]},"MemberProfile":{"additionalProperties":false,"properties":{"contextTokens":{"maximum":4294967295,"minimum":1,"type":["integer","null"]},"endpoint":{"type":"string"},"maxOutputTokens":{"maximum":16384,"minimum":0,"type":"integer"},"model":{"type":"string"},"tokenField":{"$ref":"#/$defs/TokenField"}},"required":["endpoint","model","tokenField","maxOutputTokens","contextTokens"],"type":"object"},"MemberReply":{"oneOf":[{"additionalProperties":false,"properties":{"kind":{"const":"prepared","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"sharedView":{"anyOf":[{"$ref":"#/$defs/MemberSharedView"},{"type":"null"}]}},"required":["kind","requestId","sharedView"],"type":"object"},{"additionalProperties":false,"properties":{"body":{"type":"string"},"contentType":{"type":["string","null"]},"kind":{"const":"http","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"status":{"maximum":65535,"minimum":0,"type":"integer"}},"required":["kind","requestId","status","contentType","body"],"type":"object"},{"additionalProperties":false,"properties":{"block":{"type":"boolean"},"kind":{"const":"tool-admission","type":"string"},"reason":{"type":["string","null"]}},"required":["kind","block","reason"],"type":"object"},{"additionalProperties":false,"properties":{"content":true,"details":true,"isError":{"type":"boolean"},"kind":{"const":"tool-result","type":"string"}},"required":["kind","content","details","isError"],"type":"object"},{"additionalProperties":false,"properties":{"content":true,"isError":{"type":["boolean","null"]},"kind":{"const":"tool-finalized","type":"string"}},"required":["kind","content","isError"],"type":"object"},{"additionalProperties":false,"properties":{"action":{"$ref":"#/$defs/TurnAction"},"kind":{"const":"turn","type":"string"}},"required":["kind","action"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"recorded","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"error":{"$ref":"#/$defs/ExecutionError"},"kind":{"const":"rejected","type":"string"}},"required":["kind","error"],"type":"object"}]},"MemberSharedView":{"additionalProperties":false,"properties":{"utf8":{"type":"string"},"viewId":{"$ref":"#/$defs/ExecutionId"}},"required":["viewId","utf8"],"type":"object"},"MemberTool":{"additionalProperties":false,"properties":{"description":{"type":"string"},"name":{"type":"string"},"parameters":true},"required":["name","description","parameters"],"type":"object"},"Revision":{"pattern":"^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$","type":"string"},"TokenField":{"enum":["max_tokens","max_completion_tokens","chatgpt_subscription"],"type":"string"},"TurnAction":{"enum":["normal","end","continue"],"type":"string"},"UnsignedDecimal":{"pattern":"^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$","type":"string"},"Usage":{"additionalProperties":false,"properties":{"cacheReadTokens":{"anyOf":[{"$ref":"#/$defs/UnsignedDecimal"},{"type":"null"}]},"cacheWriteTokens":{"anyOf":[{"$ref":"#/$defs/UnsignedDecimal"},{"type":"null"}]},"completionTokens":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"promptTokens":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"reasoningTokens":{"anyOf":[{"$ref":"#/$defs/UnsignedDecimal"},{"type":"null"}]}},"required":["promptTokens","completionTokens","cacheReadTokens","cacheWriteTokens","reasoningTokens"],"type":"object"}},"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"properties":{"body":{"$ref":"#/$defs/MemberBody"},"protocolVersion":{"maximum":4,"minimum":4,"type":"integer"},"sequence":{"maximum":4294967295,"minimum":0,"type":"integer"},"sessionId":{"$ref":"#/$defs/ExecutionId"}},"required":["protocolVersion","sessionId","sequence","body"],"title":"MemberFrame","type":"object"};
const schema33 = {"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"};
const schema32 = {"oneOf":[{"additionalProperties":false,"properties":{"context":true,"contextVersion":{"type":"string"},"input":{"type":"string"},"kind":{"const":"start","type":"string"},"maxTurns":{"maximum":4294967295,"minimum":0,"type":"integer"},"memberId":{"$ref":"#/$defs/ExecutionId"},"profile":{"$ref":"#/$defs/MemberProfile"},"systemPrompt":{"type":"string"},"timeoutMs":{"maximum":4294967295,"minimum":0,"type":"integer"},"tools":{"items":{"$ref":"#/$defs/MemberTool"},"type":"array"},"workItemId":{"$ref":"#/$defs/ExecutionId"}},"required":["kind","memberId","workItemId","contextVersion","profile","systemPrompt","context","input","tools","maxTurns","timeoutMs"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"ready","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"call":{"$ref":"#/$defs/MemberCall"},"kind":{"const":"request","type":"string"},"request":{"maximum":4294967295,"minimum":0,"type":"integer"}},"required":["kind","request","call"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"reply","type":"string"},"reply":{"$ref":"#/$defs/MemberReply"},"request":{"maximum":4294967295,"minimum":0,"type":"integer"}},"required":["kind","request","reply"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"guide","type":"string"},"text":{"type":"string"}},"required":["kind","text"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"close","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"result","type":"string"},"messages":true,"turnLimitReached":{"type":"boolean"}},"required":["kind","messages","turnLimitReached"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"closed","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"code":{"type":"string"},"kind":{"const":"fault","type":"string"}},"required":["kind","code"],"type":"object"}]};
const schema36 = {"additionalProperties":false,"properties":{"description":{"type":"string"},"name":{"type":"string"},"parameters":true},"required":["name","description","parameters"],"type":"object"};
const func1 = Object.prototype.hasOwnProperty;
const pattern4 = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", "u");
const schema34 = {"additionalProperties":false,"properties":{"contextTokens":{"maximum":4294967295,"minimum":1,"type":["integer","null"]},"endpoint":{"type":"string"},"maxOutputTokens":{"maximum":16384,"minimum":0,"type":"integer"},"model":{"type":"string"},"tokenField":{"$ref":"#/$defs/TokenField"}},"required":["endpoint","model","tokenField","maxOutputTokens","contextTokens"],"type":"object"};
const schema35 = {"enum":["max_tokens","max_completion_tokens","chatgpt_subscription"],"type":"string"};

function validate22(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate22.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.endpoint === undefined) && (missing0 = "endpoint")) || ((data.model === undefined) && (missing0 = "model"))) || ((data.tokenField === undefined) && (missing0 = "tokenField"))) || ((data.maxOutputTokens === undefined) && (missing0 = "maxOutputTokens"))) || ((data.contextTokens === undefined) && (missing0 = "contextTokens"))){
validate22.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((key0 === "contextTokens") || (key0 === "endpoint")) || (key0 === "maxOutputTokens")) || (key0 === "model")) || (key0 === "tokenField"))){
validate22.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.contextTokens !== undefined){
let data0 = data.contextTokens;
const _errs2 = errors;
if((!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))) && (data0 !== null)){
validate22.errors = [{instancePath:instancePath+"/contextTokens",schemaPath:"#/properties/contextTokens/type",keyword:"type",params:{type: schema34.properties.contextTokens.type},message:"must be integer,null"}];
return false;
}
if(errors === _errs2){
if((typeof data0 == "number") && (isFinite(data0))){
if(data0 > 4294967295 || isNaN(data0)){
validate22.errors = [{instancePath:instancePath+"/contextTokens",schemaPath:"#/properties/contextTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data0 < 1 || isNaN(data0)){
validate22.errors = [{instancePath:instancePath+"/contextTokens",schemaPath:"#/properties/contextTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.endpoint !== undefined){
const _errs4 = errors;
if(typeof data.endpoint !== "string"){
validate22.errors = [{instancePath:instancePath+"/endpoint",schemaPath:"#/properties/endpoint/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.maxOutputTokens !== undefined){
let data2 = data.maxOutputTokens;
const _errs6 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate22.errors = [{instancePath:instancePath+"/maxOutputTokens",schemaPath:"#/properties/maxOutputTokens/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 16384 || isNaN(data2)){
validate22.errors = [{instancePath:instancePath+"/maxOutputTokens",schemaPath:"#/properties/maxOutputTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 16384},message:"must be <= 16384"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate22.errors = [{instancePath:instancePath+"/maxOutputTokens",schemaPath:"#/properties/maxOutputTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.model !== undefined){
const _errs8 = errors;
if(typeof data.model !== "string"){
validate22.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.tokenField !== undefined){
let data4 = data.tokenField;
const _errs10 = errors;
if(typeof data4 !== "string"){
validate22.errors = [{instancePath:instancePath+"/tokenField",schemaPath:"#/$defs/TokenField/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data4 === "max_tokens") || (data4 === "max_completion_tokens")) || (data4 === "chatgpt_subscription"))){
validate22.errors = [{instancePath:instancePath+"/tokenField",schemaPath:"#/$defs/TokenField/enum",keyword:"enum",params:{allowedValues: schema35.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
else {
validate22.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate22.errors = vErrors;
return errors === 0;
}
validate22.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema38 = {"oneOf":[{"additionalProperties":false,"properties":{"messages":true,"method":{"const":"prepare","type":"string"}},"required":["method","messages"],"type":"object"},{"additionalProperties":false,"properties":{"body":{"type":"string"},"endpoint":{"type":"string"},"method":{"const":"http","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"}},"required":["method","requestId","endpoint","body"],"type":"object"},{"additionalProperties":false,"properties":{"arguments":true,"callId":{"type":"string"},"method":{"const":"before-tool","type":"string"},"name":{"type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"}},"required":["method","requestId","callId","name","arguments"],"type":"object"},{"additionalProperties":false,"properties":{"arguments":true,"callId":{"type":"string"},"method":{"const":"execute-tool","type":"string"},"name":{"type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"}},"required":["method","requestId","callId","name","arguments"],"type":"object"},{"additionalProperties":false,"properties":{"callId":{"type":"string"},"isError":{"type":"boolean"},"method":{"const":"after-tool","type":"string"},"name":{"type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"result":true},"required":["method","requestId","callId","name","result","isError"],"type":"object"},{"additionalProperties":false,"properties":{"method":{"const":"finish-turn","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"stopReason":{"type":"string"}},"required":["method","requestId","stopReason"],"type":"object"},{"additionalProperties":false,"properties":{"event":true,"method":{"const":"event","type":"string"},"requestId":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]}},"required":["method","requestId","event"],"type":"object"},{"additionalProperties":false,"properties":{"method":{"const":"usage","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"usage":{"anyOf":[{"$ref":"#/$defs/Usage"},{"type":"null"}]}},"required":["method","requestId","usage"],"type":"object"}]};
const schema46 = {"additionalProperties":false,"properties":{"cacheReadTokens":{"anyOf":[{"$ref":"#/$defs/UnsignedDecimal"},{"type":"null"}]},"cacheWriteTokens":{"anyOf":[{"$ref":"#/$defs/UnsignedDecimal"},{"type":"null"}]},"completionTokens":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"promptTokens":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"reasoningTokens":{"anyOf":[{"$ref":"#/$defs/UnsignedDecimal"},{"type":"null"}]}},"required":["promptTokens","completionTokens","cacheReadTokens","cacheWriteTokens","reasoningTokens"],"type":"object"};
const schema47 = {"pattern":"^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$","type":"string"};
const pattern13 = new RegExp("^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$", "u");

function validate25(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate25.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.promptTokens === undefined) && (missing0 = "promptTokens")) || ((data.completionTokens === undefined) && (missing0 = "completionTokens"))) || ((data.cacheReadTokens === undefined) && (missing0 = "cacheReadTokens"))) || ((data.cacheWriteTokens === undefined) && (missing0 = "cacheWriteTokens"))) || ((data.reasoningTokens === undefined) && (missing0 = "reasoningTokens"))){
validate25.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((key0 === "cacheReadTokens") || (key0 === "cacheWriteTokens")) || (key0 === "completionTokens")) || (key0 === "promptTokens")) || (key0 === "reasoningTokens"))){
validate25.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.cacheReadTokens !== undefined){
let data0 = data.cacheReadTokens;
const _errs2 = errors;
const _errs3 = errors;
let valid1 = false;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(typeof data0 === "string"){
if(!pattern13.test(data0)){
const err0 = {instancePath:instancePath+"/cacheReadTokens",schemaPath:"#/$defs/UnsignedDecimal/pattern",keyword:"pattern",params:{pattern: "^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$"},message:"must match pattern \""+"^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$"+"\""};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
}
else {
const err1 = {instancePath:instancePath+"/cacheReadTokens",schemaPath:"#/$defs/UnsignedDecimal/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
}
var _valid0 = _errs4 === errors;
valid1 = valid1 || _valid0;
const _errs7 = errors;
if(data0 !== null){
const err2 = {instancePath:instancePath+"/cacheReadTokens",schemaPath:"#/properties/cacheReadTokens/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var _valid0 = _errs7 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err3 = {instancePath:instancePath+"/cacheReadTokens",schemaPath:"#/properties/cacheReadTokens/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
validate25.errors = vErrors;
return false;
}
else {
errors = _errs3;
if(vErrors !== null){
if(_errs3){
vErrors.length = _errs3;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.cacheWriteTokens !== undefined){
let data1 = data.cacheWriteTokens;
const _errs9 = errors;
const _errs10 = errors;
let valid3 = false;
const _errs11 = errors;
const _errs12 = errors;
if(errors === _errs12){
if(typeof data1 === "string"){
if(!pattern13.test(data1)){
const err4 = {instancePath:instancePath+"/cacheWriteTokens",schemaPath:"#/$defs/UnsignedDecimal/pattern",keyword:"pattern",params:{pattern: "^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$"},message:"must match pattern \""+"^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$"+"\""};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
else {
const err5 = {instancePath:instancePath+"/cacheWriteTokens",schemaPath:"#/$defs/UnsignedDecimal/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
}
var _valid1 = _errs11 === errors;
valid3 = valid3 || _valid1;
const _errs14 = errors;
if(data1 !== null){
const err6 = {instancePath:instancePath+"/cacheWriteTokens",schemaPath:"#/properties/cacheWriteTokens/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
var _valid1 = _errs14 === errors;
valid3 = valid3 || _valid1;
if(!valid3){
const err7 = {instancePath:instancePath+"/cacheWriteTokens",schemaPath:"#/properties/cacheWriteTokens/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
validate25.errors = vErrors;
return false;
}
else {
errors = _errs10;
if(vErrors !== null){
if(_errs10){
vErrors.length = _errs10;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs9 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.completionTokens !== undefined){
let data2 = data.completionTokens;
const _errs16 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate25.errors = [{instancePath:instancePath+"/completionTokens",schemaPath:"#/properties/completionTokens/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs16){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 9007199254740991 || isNaN(data2)){
validate25.errors = [{instancePath:instancePath+"/completionTokens",schemaPath:"#/properties/completionTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991},message:"must be <= 9007199254740991"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate25.errors = [{instancePath:instancePath+"/completionTokens",schemaPath:"#/properties/completionTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs16 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.promptTokens !== undefined){
let data3 = data.promptTokens;
const _errs18 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate25.errors = [{instancePath:instancePath+"/promptTokens",schemaPath:"#/properties/promptTokens/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs18){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 9007199254740991 || isNaN(data3)){
validate25.errors = [{instancePath:instancePath+"/promptTokens",schemaPath:"#/properties/promptTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991},message:"must be <= 9007199254740991"}];
return false;
}
else {
if(data3 < 0 || isNaN(data3)){
validate25.errors = [{instancePath:instancePath+"/promptTokens",schemaPath:"#/properties/promptTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs18 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.reasoningTokens !== undefined){
let data4 = data.reasoningTokens;
const _errs20 = errors;
const _errs21 = errors;
let valid5 = false;
const _errs22 = errors;
const _errs23 = errors;
if(errors === _errs23){
if(typeof data4 === "string"){
if(!pattern13.test(data4)){
const err8 = {instancePath:instancePath+"/reasoningTokens",schemaPath:"#/$defs/UnsignedDecimal/pattern",keyword:"pattern",params:{pattern: "^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$"},message:"must match pattern \""+"^(0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|18446744073709551615)$"+"\""};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
else {
const err9 = {instancePath:instancePath+"/reasoningTokens",schemaPath:"#/$defs/UnsignedDecimal/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
var _valid2 = _errs22 === errors;
valid5 = valid5 || _valid2;
const _errs25 = errors;
if(data4 !== null){
const err10 = {instancePath:instancePath+"/reasoningTokens",schemaPath:"#/properties/reasoningTokens/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var _valid2 = _errs25 === errors;
valid5 = valid5 || _valid2;
if(!valid5){
const err11 = {instancePath:instancePath+"/reasoningTokens",schemaPath:"#/properties/reasoningTokens/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
validate25.errors = vErrors;
return false;
}
else {
errors = _errs21;
if(vErrors !== null){
if(_errs21){
vErrors.length = _errs21;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs20 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
else {
validate25.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate25.errors = vErrors;
return errors === 0;
}
validate25.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate24(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate24.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.method === undefined) && (missing0 = "method")) || ((data.messages === undefined) && (missing0 = "messages"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!((key0 === "messages") || (key0 === "method"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.method !== undefined){
let data0 = data.method;
if(typeof data0 !== "string"){
const err2 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/0/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("prepare" !== data0){
const err3 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/0/properties/method/const",keyword:"const",params:{allowedValue: "prepare"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
}
}
}
}
else {
const err4 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs6 = errors;
if(errors === _errs6){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if(((((data.method === undefined) && (missing1 = "method")) || ((data.requestId === undefined) && (missing1 = "requestId"))) || ((data.endpoint === undefined) && (missing1 = "endpoint"))) || ((data.body === undefined) && (missing1 = "body"))){
const err5 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
else {
const _errs8 = errors;
for(const key1 in data){
if(!((((key1 === "body") || (key1 === "endpoint")) || (key1 === "method")) || (key1 === "requestId"))){
const err6 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
break;
}
}
if(_errs8 === errors){
if(data.body !== undefined){
const _errs9 = errors;
if(typeof data.body !== "string"){
const err7 = {instancePath:instancePath+"/body",schemaPath:"#/oneOf/1/properties/body/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.endpoint !== undefined){
const _errs11 = errors;
if(typeof data.endpoint !== "string"){
const err8 = {instancePath:instancePath+"/endpoint",schemaPath:"#/oneOf/1/properties/endpoint/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
var valid2 = _errs11 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.method !== undefined){
let data3 = data.method;
const _errs13 = errors;
if(typeof data3 !== "string"){
const err9 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/1/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
if("http" !== data3){
const err10 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/1/properties/method/const",keyword:"const",params:{allowedValue: "http"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var valid2 = _errs13 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.requestId !== undefined){
let data4 = data.requestId;
const _errs15 = errors;
const _errs16 = errors;
if(errors === _errs16){
if(typeof data4 === "string"){
if(!pattern4.test(data4)){
const err11 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
else {
const err12 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
var valid2 = _errs15 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
}
else {
const err13 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
var _valid0 = _errs6 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
const _errs18 = errors;
if(errors === _errs18){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if((((((data.method === undefined) && (missing2 = "method")) || ((data.requestId === undefined) && (missing2 = "requestId"))) || ((data.callId === undefined) && (missing2 = "callId"))) || ((data.name === undefined) && (missing2 = "name"))) || ((data.arguments === undefined) && (missing2 = "arguments"))){
const err14 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
else {
const _errs20 = errors;
for(const key2 in data){
if(!(((((key2 === "arguments") || (key2 === "callId")) || (key2 === "method")) || (key2 === "name")) || (key2 === "requestId"))){
const err15 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
break;
}
}
if(_errs20 === errors){
if(data.callId !== undefined){
const _errs21 = errors;
if(typeof data.callId !== "string"){
const err16 = {instancePath:instancePath+"/callId",schemaPath:"#/oneOf/2/properties/callId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.method !== undefined){
let data6 = data.method;
const _errs23 = errors;
if(typeof data6 !== "string"){
const err17 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/2/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if("before-tool" !== data6){
const err18 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/2/properties/method/const",keyword:"const",params:{allowedValue: "before-tool"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
var valid4 = _errs23 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.name !== undefined){
const _errs25 = errors;
if(typeof data.name !== "string"){
const err19 = {instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
var valid4 = _errs25 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.requestId !== undefined){
let data8 = data.requestId;
const _errs27 = errors;
const _errs28 = errors;
if(errors === _errs28){
if(typeof data8 === "string"){
if(!pattern4.test(data8)){
const err20 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
else {
const err21 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
}
var valid4 = _errs27 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
}
else {
const err22 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
}
var _valid0 = _errs18 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 2];
}
else {
if(_valid0){
valid0 = true;
passing0 = 2;
if(props0 !== true){
props0 = true;
}
}
const _errs30 = errors;
if(errors === _errs30){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing3;
if((((((data.method === undefined) && (missing3 = "method")) || ((data.requestId === undefined) && (missing3 = "requestId"))) || ((data.callId === undefined) && (missing3 = "callId"))) || ((data.name === undefined) && (missing3 = "name"))) || ((data.arguments === undefined) && (missing3 = "arguments"))){
const err23 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
else {
const _errs32 = errors;
for(const key3 in data){
if(!(((((key3 === "arguments") || (key3 === "callId")) || (key3 === "method")) || (key3 === "name")) || (key3 === "requestId"))){
const err24 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
break;
}
}
if(_errs32 === errors){
if(data.callId !== undefined){
const _errs33 = errors;
if(typeof data.callId !== "string"){
const err25 = {instancePath:instancePath+"/callId",schemaPath:"#/oneOf/3/properties/callId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
var valid6 = _errs33 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.method !== undefined){
let data10 = data.method;
const _errs35 = errors;
if(typeof data10 !== "string"){
const err26 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/3/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
if("execute-tool" !== data10){
const err27 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/3/properties/method/const",keyword:"const",params:{allowedValue: "execute-tool"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
var valid6 = _errs35 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.name !== undefined){
const _errs37 = errors;
if(typeof data.name !== "string"){
const err28 = {instancePath:instancePath+"/name",schemaPath:"#/oneOf/3/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
var valid6 = _errs37 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.requestId !== undefined){
let data12 = data.requestId;
const _errs39 = errors;
const _errs40 = errors;
if(errors === _errs40){
if(typeof data12 === "string"){
if(!pattern4.test(data12)){
const err29 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
}
else {
const err30 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
}
var valid6 = _errs39 === errors;
}
else {
var valid6 = true;
}
}
}
}
}
}
}
else {
const err31 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
}
var _valid0 = _errs30 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 3];
}
else {
if(_valid0){
valid0 = true;
passing0 = 3;
if(props0 !== true){
props0 = true;
}
}
const _errs42 = errors;
if(errors === _errs42){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if(((((((data.method === undefined) && (missing4 = "method")) || ((data.requestId === undefined) && (missing4 = "requestId"))) || ((data.callId === undefined) && (missing4 = "callId"))) || ((data.name === undefined) && (missing4 = "name"))) || ((data.result === undefined) && (missing4 = "result"))) || ((data.isError === undefined) && (missing4 = "isError"))){
const err32 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
else {
const _errs44 = errors;
for(const key4 in data){
if(!((((((key4 === "callId") || (key4 === "isError")) || (key4 === "method")) || (key4 === "name")) || (key4 === "requestId")) || (key4 === "result"))){
const err33 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
break;
}
}
if(_errs44 === errors){
if(data.callId !== undefined){
const _errs45 = errors;
if(typeof data.callId !== "string"){
const err34 = {instancePath:instancePath+"/callId",schemaPath:"#/oneOf/4/properties/callId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
var valid8 = _errs45 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.isError !== undefined){
const _errs47 = errors;
if(typeof data.isError !== "boolean"){
const err35 = {instancePath:instancePath+"/isError",schemaPath:"#/oneOf/4/properties/isError/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
var valid8 = _errs47 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.method !== undefined){
let data15 = data.method;
const _errs49 = errors;
if(typeof data15 !== "string"){
const err36 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/4/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
if("after-tool" !== data15){
const err37 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/4/properties/method/const",keyword:"const",params:{allowedValue: "after-tool"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
var valid8 = _errs49 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.name !== undefined){
const _errs51 = errors;
if(typeof data.name !== "string"){
const err38 = {instancePath:instancePath+"/name",schemaPath:"#/oneOf/4/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
var valid8 = _errs51 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.requestId !== undefined){
let data17 = data.requestId;
const _errs53 = errors;
const _errs54 = errors;
if(errors === _errs54){
if(typeof data17 === "string"){
if(!pattern4.test(data17)){
const err39 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
}
else {
const err40 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
}
var valid8 = _errs53 === errors;
}
else {
var valid8 = true;
}
}
}
}
}
}
}
}
else {
const err41 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
}
var _valid0 = _errs42 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 4];
}
else {
if(_valid0){
valid0 = true;
passing0 = 4;
if(props0 !== true){
props0 = true;
}
}
const _errs56 = errors;
if(errors === _errs56){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if((((data.method === undefined) && (missing5 = "method")) || ((data.requestId === undefined) && (missing5 = "requestId"))) || ((data.stopReason === undefined) && (missing5 = "stopReason"))){
const err42 = {instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
else {
const _errs58 = errors;
for(const key5 in data){
if(!(((key5 === "method") || (key5 === "requestId")) || (key5 === "stopReason"))){
const err43 = {instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
break;
}
}
if(_errs58 === errors){
if(data.method !== undefined){
let data18 = data.method;
const _errs59 = errors;
if(typeof data18 !== "string"){
const err44 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/5/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
if("finish-turn" !== data18){
const err45 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/5/properties/method/const",keyword:"const",params:{allowedValue: "finish-turn"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
var valid10 = _errs59 === errors;
}
else {
var valid10 = true;
}
if(valid10){
if(data.requestId !== undefined){
let data19 = data.requestId;
const _errs61 = errors;
const _errs62 = errors;
if(errors === _errs62){
if(typeof data19 === "string"){
if(!pattern4.test(data19)){
const err46 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
}
else {
const err47 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
}
var valid10 = _errs61 === errors;
}
else {
var valid10 = true;
}
if(valid10){
if(data.stopReason !== undefined){
const _errs64 = errors;
if(typeof data.stopReason !== "string"){
const err48 = {instancePath:instancePath+"/stopReason",schemaPath:"#/oneOf/5/properties/stopReason/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
var valid10 = _errs64 === errors;
}
else {
var valid10 = true;
}
}
}
}
}
}
else {
const err49 = {instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
}
var _valid0 = _errs56 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 5];
}
else {
if(_valid0){
valid0 = true;
passing0 = 5;
if(props0 !== true){
props0 = true;
}
}
const _errs66 = errors;
if(errors === _errs66){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing6;
if((((data.method === undefined) && (missing6 = "method")) || ((data.requestId === undefined) && (missing6 = "requestId"))) || ((data.event === undefined) && (missing6 = "event"))){
const err50 = {instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6},message:"must have required property '"+missing6+"'"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
else {
const _errs68 = errors;
for(const key6 in data){
if(!(((key6 === "event") || (key6 === "method")) || (key6 === "requestId"))){
const err51 = {instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
break;
}
}
if(_errs68 === errors){
if(data.method !== undefined){
let data21 = data.method;
const _errs69 = errors;
if(typeof data21 !== "string"){
const err52 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/6/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
if("event" !== data21){
const err53 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/6/properties/method/const",keyword:"const",params:{allowedValue: "event"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
var valid12 = _errs69 === errors;
}
else {
var valid12 = true;
}
if(valid12){
if(data.requestId !== undefined){
let data22 = data.requestId;
const _errs71 = errors;
const _errs72 = errors;
let valid13 = false;
const _errs73 = errors;
const _errs74 = errors;
if(errors === _errs74){
if(typeof data22 === "string"){
if(!pattern4.test(data22)){
const err54 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
}
else {
const err55 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err55];
}
else {
vErrors.push(err55);
}
errors++;
}
}
var _valid1 = _errs73 === errors;
valid13 = valid13 || _valid1;
const _errs76 = errors;
if(data22 !== null){
const err56 = {instancePath:instancePath+"/requestId",schemaPath:"#/oneOf/6/properties/requestId/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err56];
}
else {
vErrors.push(err56);
}
errors++;
}
var _valid1 = _errs76 === errors;
valid13 = valid13 || _valid1;
if(!valid13){
const err57 = {instancePath:instancePath+"/requestId",schemaPath:"#/oneOf/6/properties/requestId/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err57];
}
else {
vErrors.push(err57);
}
errors++;
}
else {
errors = _errs72;
if(vErrors !== null){
if(_errs72){
vErrors.length = _errs72;
}
else {
vErrors = null;
}
}
}
var valid12 = _errs71 === errors;
}
else {
var valid12 = true;
}
}
}
}
}
else {
const err58 = {instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err58];
}
else {
vErrors.push(err58);
}
errors++;
}
}
var _valid0 = _errs66 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 6];
}
else {
if(_valid0){
valid0 = true;
passing0 = 6;
if(props0 !== true){
props0 = true;
}
}
const _errs78 = errors;
if(errors === _errs78){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing7;
if((((data.method === undefined) && (missing7 = "method")) || ((data.requestId === undefined) && (missing7 = "requestId"))) || ((data.usage === undefined) && (missing7 = "usage"))){
const err59 = {instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing7},message:"must have required property '"+missing7+"'"};
if(vErrors === null){
vErrors = [err59];
}
else {
vErrors.push(err59);
}
errors++;
}
else {
const _errs80 = errors;
for(const key7 in data){
if(!(((key7 === "method") || (key7 === "requestId")) || (key7 === "usage"))){
const err60 = {instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err60];
}
else {
vErrors.push(err60);
}
errors++;
break;
}
}
if(_errs80 === errors){
if(data.method !== undefined){
let data23 = data.method;
const _errs81 = errors;
if(typeof data23 !== "string"){
const err61 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/7/properties/method/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err61];
}
else {
vErrors.push(err61);
}
errors++;
}
if("usage" !== data23){
const err62 = {instancePath:instancePath+"/method",schemaPath:"#/oneOf/7/properties/method/const",keyword:"const",params:{allowedValue: "usage"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err62];
}
else {
vErrors.push(err62);
}
errors++;
}
var valid15 = _errs81 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data.requestId !== undefined){
let data24 = data.requestId;
const _errs83 = errors;
const _errs84 = errors;
if(errors === _errs84){
if(typeof data24 === "string"){
if(!pattern4.test(data24)){
const err63 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err63];
}
else {
vErrors.push(err63);
}
errors++;
}
}
else {
const err64 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err64];
}
else {
vErrors.push(err64);
}
errors++;
}
}
var valid15 = _errs83 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data.usage !== undefined){
let data25 = data.usage;
const _errs86 = errors;
const _errs87 = errors;
let valid17 = false;
const _errs88 = errors;
if(!(validate25(data25, {instancePath:instancePath+"/usage",parentData:data,parentDataProperty:"usage",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate25.errors : vErrors.concat(validate25.errors);
errors = vErrors.length;
}
var _valid2 = _errs88 === errors;
valid17 = valid17 || _valid2;
const _errs89 = errors;
if(data25 !== null){
const err65 = {instancePath:instancePath+"/usage",schemaPath:"#/oneOf/7/properties/usage/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err65];
}
else {
vErrors.push(err65);
}
errors++;
}
var _valid2 = _errs89 === errors;
valid17 = valid17 || _valid2;
if(!valid17){
const err66 = {instancePath:instancePath+"/usage",schemaPath:"#/oneOf/7/properties/usage/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err66];
}
else {
vErrors.push(err66);
}
errors++;
}
else {
errors = _errs87;
if(vErrors !== null){
if(_errs87){
vErrors.length = _errs87;
}
else {
vErrors = null;
}
}
}
var valid15 = _errs86 === errors;
}
else {
var valid15 = true;
}
}
}
}
}
}
else {
const err67 = {instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err67];
}
else {
vErrors.push(err67);
}
errors++;
}
}
var _valid0 = _errs78 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 7];
}
else {
if(_valid0){
valid0 = true;
passing0 = 7;
if(props0 !== true){
props0 = true;
}
}
}
}
}
}
}
}
}
if(!valid0){
const err68 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err68];
}
else {
vErrors.push(err68);
}
errors++;
validate24.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate24.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate24.evaluated = {"dynamicProps":true,"dynamicItems":false};

const schema50 = {"oneOf":[{"additionalProperties":false,"properties":{"kind":{"const":"prepared","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"sharedView":{"anyOf":[{"$ref":"#/$defs/MemberSharedView"},{"type":"null"}]}},"required":["kind","requestId","sharedView"],"type":"object"},{"additionalProperties":false,"properties":{"body":{"type":"string"},"contentType":{"type":["string","null"]},"kind":{"const":"http","type":"string"},"requestId":{"$ref":"#/$defs/ExecutionId"},"status":{"maximum":65535,"minimum":0,"type":"integer"}},"required":["kind","requestId","status","contentType","body"],"type":"object"},{"additionalProperties":false,"properties":{"block":{"type":"boolean"},"kind":{"const":"tool-admission","type":"string"},"reason":{"type":["string","null"]}},"required":["kind","block","reason"],"type":"object"},{"additionalProperties":false,"properties":{"content":true,"details":true,"isError":{"type":"boolean"},"kind":{"const":"tool-result","type":"string"}},"required":["kind","content","details","isError"],"type":"object"},{"additionalProperties":false,"properties":{"content":true,"isError":{"type":["boolean","null"]},"kind":{"const":"tool-finalized","type":"string"}},"required":["kind","content","isError"],"type":"object"},{"additionalProperties":false,"properties":{"action":{"$ref":"#/$defs/TurnAction"},"kind":{"const":"turn","type":"string"}},"required":["kind","action"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"recorded","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"error":{"$ref":"#/$defs/ExecutionError"},"kind":{"const":"rejected","type":"string"}},"required":["kind","error"],"type":"object"}]};
const schema55 = {"enum":["normal","end","continue"],"type":"string"};
const schema52 = {"additionalProperties":false,"properties":{"utf8":{"type":"string"},"viewId":{"$ref":"#/$defs/ExecutionId"}},"required":["viewId","utf8"],"type":"object"};

function validate29(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate29.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.viewId === undefined) && (missing0 = "viewId")) || ((data.utf8 === undefined) && (missing0 = "utf8"))){
validate29.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "utf8") || (key0 === "viewId"))){
validate29.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.utf8 !== undefined){
const _errs2 = errors;
if(typeof data.utf8 !== "string"){
validate29.errors = [{instancePath:instancePath+"/utf8",schemaPath:"#/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.viewId !== undefined){
let data1 = data.viewId;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(typeof data1 === "string"){
if(!pattern4.test(data1)){
validate29.errors = [{instancePath:instancePath+"/viewId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""}];
return false;
}
}
else {
validate29.errors = [{instancePath:instancePath+"/viewId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate29.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate29.errors = vErrors;
return errors === 0;
}
validate29.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema56 = {"additionalProperties":false,"properties":{"code":{"$ref":"#/$defs/ErrorCode"},"conflict":{"anyOf":[{"$ref":"#/$defs/ConflictEvidence"},{"type":"null"}]},"itemIds":{"items":{"$ref":"#/$defs/ExecutionId"},"type":"array"},"stage":{"type":"string"}},"required":["code","stage","itemIds"],"type":"object"};
const schema57 = {"enum":["invalid-input","limit-exceeded","result-mismatch","output-invalid","dependency-conflict","cancelled","outcome-unknown","unauthorized","busy","storage-failed","corrupt-ledger"],"type":"string"};
const schema58 = {"description":"Values compared at the rejecting boundary, without user text or credentials.","oneOf":[{"additionalProperties":false,"properties":{"current":{"$ref":"#/$defs/ExecutionId"},"expected":{"$ref":"#/$defs/ExecutionId"},"kind":{"const":"source-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"translation-selection","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"type":"string"},"expected":{"type":"string"},"kind":{"const":"review-basis","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"review-decision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"review-check","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"review-waiver","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"source-fallback","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"type":"string"},"expected":{"type":"string"},"kind":{"const":"build-eligibility","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"type":"string"},"expected":{"type":"string"},"kind":{"const":"comparison-basis","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"term-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"context-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"expected":{"anyOf":[{"$ref":"#/$defs/ExecutionId"},{"type":"null"}]},"kind":{"const":"source-snapshot","type":"string"}},"required":["kind","expected","current"],"type":"object"},{"additionalProperties":false,"properties":{"current":{"$ref":"#/$defs/Revision"},"expected":{"$ref":"#/$defs/Revision"},"kind":{"const":"content-revision","type":"string"}},"required":["kind","expected","current"],"type":"object"}]};
const schema77 = {"pattern":"^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$","type":"string"};
const pattern37 = new RegExp("^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$", "u");

function validate32(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate32.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.kind === undefined) && (missing0 = "kind")) || ((data.expected === undefined) && (missing0 = "expected"))) || ((data.current === undefined) && (missing0 = "current"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!(((key0 === "current") || (key0 === "expected")) || (key0 === "kind"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.current !== undefined){
let data0 = data.current;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(typeof data0 === "string"){
if(!pattern4.test(data0)){
const err2 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
else {
const err3 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.expected !== undefined){
let data1 = data.expected;
const _errs7 = errors;
const _errs8 = errors;
if(errors === _errs8){
if(typeof data1 === "string"){
if(!pattern4.test(data1)){
const err4 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
else {
const err5 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
}
var valid1 = _errs7 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.kind !== undefined){
let data2 = data.kind;
const _errs10 = errors;
if(typeof data2 !== "string"){
const err6 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if("source-revision" !== data2){
const err7 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "source-revision"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
var valid1 = _errs10 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
}
else {
const err8 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs12 = errors;
if(errors === _errs12){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if((((data.kind === undefined) && (missing1 = "kind")) || ((data.expected === undefined) && (missing1 = "expected"))) || ((data.current === undefined) && (missing1 = "current"))){
const err9 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
else {
const _errs14 = errors;
for(const key1 in data){
if(!(((key1 === "current") || (key1 === "expected")) || (key1 === "kind"))){
const err10 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
break;
}
}
if(_errs14 === errors){
if(data.current !== undefined){
let data3 = data.current;
const _errs15 = errors;
const _errs16 = errors;
let valid5 = false;
const _errs17 = errors;
const _errs18 = errors;
if(errors === _errs18){
if(typeof data3 === "string"){
if(!pattern4.test(data3)){
const err11 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
else {
const err12 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
var _valid1 = _errs17 === errors;
valid5 = valid5 || _valid1;
const _errs20 = errors;
if(data3 !== null){
const err13 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/1/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
var _valid1 = _errs20 === errors;
valid5 = valid5 || _valid1;
if(!valid5){
const err14 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/1/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
else {
errors = _errs16;
if(vErrors !== null){
if(_errs16){
vErrors.length = _errs16;
}
else {
vErrors = null;
}
}
}
var valid4 = _errs15 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.expected !== undefined){
let data4 = data.expected;
const _errs22 = errors;
const _errs23 = errors;
let valid7 = false;
const _errs24 = errors;
const _errs25 = errors;
if(errors === _errs25){
if(typeof data4 === "string"){
if(!pattern4.test(data4)){
const err15 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
else {
const err16 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
var _valid2 = _errs24 === errors;
valid7 = valid7 || _valid2;
const _errs27 = errors;
if(data4 !== null){
const err17 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/1/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
var _valid2 = _errs27 === errors;
valid7 = valid7 || _valid2;
if(!valid7){
const err18 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/1/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
else {
errors = _errs23;
if(vErrors !== null){
if(_errs23){
vErrors.length = _errs23;
}
else {
vErrors = null;
}
}
}
var valid4 = _errs22 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs29 = errors;
if(typeof data5 !== "string"){
const err19 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
if("translation-selection" !== data5){
const err20 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "translation-selection"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
var valid4 = _errs29 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
else {
const err21 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
}
var _valid0 = _errs12 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
const _errs31 = errors;
if(errors === _errs31){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if((((data.kind === undefined) && (missing2 = "kind")) || ((data.expected === undefined) && (missing2 = "expected"))) || ((data.current === undefined) && (missing2 = "current"))){
const err22 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
else {
const _errs33 = errors;
for(const key2 in data){
if(!(((key2 === "current") || (key2 === "expected")) || (key2 === "kind"))){
const err23 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
break;
}
}
if(_errs33 === errors){
if(data.current !== undefined){
const _errs34 = errors;
if(typeof data.current !== "string"){
const err24 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/2/properties/current/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
var valid9 = _errs34 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data.expected !== undefined){
const _errs36 = errors;
if(typeof data.expected !== "string"){
const err25 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/2/properties/expected/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
var valid9 = _errs36 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data.kind !== undefined){
let data8 = data.kind;
const _errs38 = errors;
if(typeof data8 !== "string"){
const err26 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
if("review-basis" !== data8){
const err27 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "review-basis"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
var valid9 = _errs38 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
}
else {
const err28 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
var _valid0 = _errs31 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 2];
}
else {
if(_valid0){
valid0 = true;
passing0 = 2;
if(props0 !== true){
props0 = true;
}
}
const _errs40 = errors;
if(errors === _errs40){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing3;
if((((data.kind === undefined) && (missing3 = "kind")) || ((data.expected === undefined) && (missing3 = "expected"))) || ((data.current === undefined) && (missing3 = "current"))){
const err29 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
else {
const _errs42 = errors;
for(const key3 in data){
if(!(((key3 === "current") || (key3 === "expected")) || (key3 === "kind"))){
const err30 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
break;
}
}
if(_errs42 === errors){
if(data.current !== undefined){
let data9 = data.current;
const _errs43 = errors;
const _errs44 = errors;
let valid11 = false;
const _errs45 = errors;
const _errs46 = errors;
if(errors === _errs46){
if(typeof data9 === "string"){
if(!pattern4.test(data9)){
const err31 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
}
else {
const err32 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
}
var _valid3 = _errs45 === errors;
valid11 = valid11 || _valid3;
const _errs48 = errors;
if(data9 !== null){
const err33 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/3/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
var _valid3 = _errs48 === errors;
valid11 = valid11 || _valid3;
if(!valid11){
const err34 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/3/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
else {
errors = _errs44;
if(vErrors !== null){
if(_errs44){
vErrors.length = _errs44;
}
else {
vErrors = null;
}
}
}
var valid10 = _errs43 === errors;
}
else {
var valid10 = true;
}
if(valid10){
if(data.expected !== undefined){
let data10 = data.expected;
const _errs50 = errors;
const _errs51 = errors;
let valid13 = false;
const _errs52 = errors;
const _errs53 = errors;
if(errors === _errs53){
if(typeof data10 === "string"){
if(!pattern4.test(data10)){
const err35 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
}
else {
const err36 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
}
var _valid4 = _errs52 === errors;
valid13 = valid13 || _valid4;
const _errs55 = errors;
if(data10 !== null){
const err37 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/3/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
var _valid4 = _errs55 === errors;
valid13 = valid13 || _valid4;
if(!valid13){
const err38 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/3/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
else {
errors = _errs51;
if(vErrors !== null){
if(_errs51){
vErrors.length = _errs51;
}
else {
vErrors = null;
}
}
}
var valid10 = _errs50 === errors;
}
else {
var valid10 = true;
}
if(valid10){
if(data.kind !== undefined){
let data11 = data.kind;
const _errs57 = errors;
if(typeof data11 !== "string"){
const err39 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
if("review-decision" !== data11){
const err40 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "review-decision"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
var valid10 = _errs57 === errors;
}
else {
var valid10 = true;
}
}
}
}
}
}
else {
const err41 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
}
var _valid0 = _errs40 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 3];
}
else {
if(_valid0){
valid0 = true;
passing0 = 3;
if(props0 !== true){
props0 = true;
}
}
const _errs59 = errors;
if(errors === _errs59){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if((((data.kind === undefined) && (missing4 = "kind")) || ((data.expected === undefined) && (missing4 = "expected"))) || ((data.current === undefined) && (missing4 = "current"))){
const err42 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
else {
const _errs61 = errors;
for(const key4 in data){
if(!(((key4 === "current") || (key4 === "expected")) || (key4 === "kind"))){
const err43 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
break;
}
}
if(_errs61 === errors){
if(data.current !== undefined){
let data12 = data.current;
const _errs62 = errors;
const _errs63 = errors;
let valid16 = false;
const _errs64 = errors;
const _errs65 = errors;
if(errors === _errs65){
if(typeof data12 === "string"){
if(!pattern4.test(data12)){
const err44 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
}
else {
const err45 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
}
var _valid5 = _errs64 === errors;
valid16 = valid16 || _valid5;
const _errs67 = errors;
if(data12 !== null){
const err46 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/4/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
var _valid5 = _errs67 === errors;
valid16 = valid16 || _valid5;
if(!valid16){
const err47 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/4/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
else {
errors = _errs63;
if(vErrors !== null){
if(_errs63){
vErrors.length = _errs63;
}
else {
vErrors = null;
}
}
}
var valid15 = _errs62 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data.expected !== undefined){
let data13 = data.expected;
const _errs69 = errors;
const _errs70 = errors;
let valid18 = false;
const _errs71 = errors;
const _errs72 = errors;
if(errors === _errs72){
if(typeof data13 === "string"){
if(!pattern4.test(data13)){
const err48 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
}
else {
const err49 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
}
var _valid6 = _errs71 === errors;
valid18 = valid18 || _valid6;
const _errs74 = errors;
if(data13 !== null){
const err50 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/4/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
var _valid6 = _errs74 === errors;
valid18 = valid18 || _valid6;
if(!valid18){
const err51 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/4/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
else {
errors = _errs70;
if(vErrors !== null){
if(_errs70){
vErrors.length = _errs70;
}
else {
vErrors = null;
}
}
}
var valid15 = _errs69 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data.kind !== undefined){
let data14 = data.kind;
const _errs76 = errors;
if(typeof data14 !== "string"){
const err52 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
if("review-check" !== data14){
const err53 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "review-check"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
var valid15 = _errs76 === errors;
}
else {
var valid15 = true;
}
}
}
}
}
}
else {
const err54 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
}
var _valid0 = _errs59 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 4];
}
else {
if(_valid0){
valid0 = true;
passing0 = 4;
if(props0 !== true){
props0 = true;
}
}
const _errs78 = errors;
if(errors === _errs78){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if((((data.kind === undefined) && (missing5 = "kind")) || ((data.expected === undefined) && (missing5 = "expected"))) || ((data.current === undefined) && (missing5 = "current"))){
const err55 = {instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err55];
}
else {
vErrors.push(err55);
}
errors++;
}
else {
const _errs80 = errors;
for(const key5 in data){
if(!(((key5 === "current") || (key5 === "expected")) || (key5 === "kind"))){
const err56 = {instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err56];
}
else {
vErrors.push(err56);
}
errors++;
break;
}
}
if(_errs80 === errors){
if(data.current !== undefined){
let data15 = data.current;
const _errs81 = errors;
const _errs82 = errors;
let valid21 = false;
const _errs83 = errors;
const _errs84 = errors;
if(errors === _errs84){
if(typeof data15 === "string"){
if(!pattern4.test(data15)){
const err57 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err57];
}
else {
vErrors.push(err57);
}
errors++;
}
}
else {
const err58 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err58];
}
else {
vErrors.push(err58);
}
errors++;
}
}
var _valid7 = _errs83 === errors;
valid21 = valid21 || _valid7;
const _errs86 = errors;
if(data15 !== null){
const err59 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/5/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err59];
}
else {
vErrors.push(err59);
}
errors++;
}
var _valid7 = _errs86 === errors;
valid21 = valid21 || _valid7;
if(!valid21){
const err60 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/5/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err60];
}
else {
vErrors.push(err60);
}
errors++;
}
else {
errors = _errs82;
if(vErrors !== null){
if(_errs82){
vErrors.length = _errs82;
}
else {
vErrors = null;
}
}
}
var valid20 = _errs81 === errors;
}
else {
var valid20 = true;
}
if(valid20){
if(data.expected !== undefined){
let data16 = data.expected;
const _errs88 = errors;
const _errs89 = errors;
let valid23 = false;
const _errs90 = errors;
const _errs91 = errors;
if(errors === _errs91){
if(typeof data16 === "string"){
if(!pattern4.test(data16)){
const err61 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err61];
}
else {
vErrors.push(err61);
}
errors++;
}
}
else {
const err62 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err62];
}
else {
vErrors.push(err62);
}
errors++;
}
}
var _valid8 = _errs90 === errors;
valid23 = valid23 || _valid8;
const _errs93 = errors;
if(data16 !== null){
const err63 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/5/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err63];
}
else {
vErrors.push(err63);
}
errors++;
}
var _valid8 = _errs93 === errors;
valid23 = valid23 || _valid8;
if(!valid23){
const err64 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/5/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err64];
}
else {
vErrors.push(err64);
}
errors++;
}
else {
errors = _errs89;
if(vErrors !== null){
if(_errs89){
vErrors.length = _errs89;
}
else {
vErrors = null;
}
}
}
var valid20 = _errs88 === errors;
}
else {
var valid20 = true;
}
if(valid20){
if(data.kind !== undefined){
let data17 = data.kind;
const _errs95 = errors;
if(typeof data17 !== "string"){
const err65 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err65];
}
else {
vErrors.push(err65);
}
errors++;
}
if("review-waiver" !== data17){
const err66 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "review-waiver"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err66];
}
else {
vErrors.push(err66);
}
errors++;
}
var valid20 = _errs95 === errors;
}
else {
var valid20 = true;
}
}
}
}
}
}
else {
const err67 = {instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err67];
}
else {
vErrors.push(err67);
}
errors++;
}
}
var _valid0 = _errs78 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 5];
}
else {
if(_valid0){
valid0 = true;
passing0 = 5;
if(props0 !== true){
props0 = true;
}
}
const _errs97 = errors;
if(errors === _errs97){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing6;
if((((data.kind === undefined) && (missing6 = "kind")) || ((data.expected === undefined) && (missing6 = "expected"))) || ((data.current === undefined) && (missing6 = "current"))){
const err68 = {instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6},message:"must have required property '"+missing6+"'"};
if(vErrors === null){
vErrors = [err68];
}
else {
vErrors.push(err68);
}
errors++;
}
else {
const _errs99 = errors;
for(const key6 in data){
if(!(((key6 === "current") || (key6 === "expected")) || (key6 === "kind"))){
const err69 = {instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err69];
}
else {
vErrors.push(err69);
}
errors++;
break;
}
}
if(_errs99 === errors){
if(data.current !== undefined){
let data18 = data.current;
const _errs100 = errors;
const _errs101 = errors;
let valid26 = false;
const _errs102 = errors;
const _errs103 = errors;
if(errors === _errs103){
if(typeof data18 === "string"){
if(!pattern4.test(data18)){
const err70 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err70];
}
else {
vErrors.push(err70);
}
errors++;
}
}
else {
const err71 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err71];
}
else {
vErrors.push(err71);
}
errors++;
}
}
var _valid9 = _errs102 === errors;
valid26 = valid26 || _valid9;
const _errs105 = errors;
if(data18 !== null){
const err72 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/6/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err72];
}
else {
vErrors.push(err72);
}
errors++;
}
var _valid9 = _errs105 === errors;
valid26 = valid26 || _valid9;
if(!valid26){
const err73 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/6/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err73];
}
else {
vErrors.push(err73);
}
errors++;
}
else {
errors = _errs101;
if(vErrors !== null){
if(_errs101){
vErrors.length = _errs101;
}
else {
vErrors = null;
}
}
}
var valid25 = _errs100 === errors;
}
else {
var valid25 = true;
}
if(valid25){
if(data.expected !== undefined){
let data19 = data.expected;
const _errs107 = errors;
const _errs108 = errors;
let valid28 = false;
const _errs109 = errors;
const _errs110 = errors;
if(errors === _errs110){
if(typeof data19 === "string"){
if(!pattern4.test(data19)){
const err74 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err74];
}
else {
vErrors.push(err74);
}
errors++;
}
}
else {
const err75 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err75];
}
else {
vErrors.push(err75);
}
errors++;
}
}
var _valid10 = _errs109 === errors;
valid28 = valid28 || _valid10;
const _errs112 = errors;
if(data19 !== null){
const err76 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/6/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err76];
}
else {
vErrors.push(err76);
}
errors++;
}
var _valid10 = _errs112 === errors;
valid28 = valid28 || _valid10;
if(!valid28){
const err77 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/6/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err77];
}
else {
vErrors.push(err77);
}
errors++;
}
else {
errors = _errs108;
if(vErrors !== null){
if(_errs108){
vErrors.length = _errs108;
}
else {
vErrors = null;
}
}
}
var valid25 = _errs107 === errors;
}
else {
var valid25 = true;
}
if(valid25){
if(data.kind !== undefined){
let data20 = data.kind;
const _errs114 = errors;
if(typeof data20 !== "string"){
const err78 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err78];
}
else {
vErrors.push(err78);
}
errors++;
}
if("source-fallback" !== data20){
const err79 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "source-fallback"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err79];
}
else {
vErrors.push(err79);
}
errors++;
}
var valid25 = _errs114 === errors;
}
else {
var valid25 = true;
}
}
}
}
}
}
else {
const err80 = {instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err80];
}
else {
vErrors.push(err80);
}
errors++;
}
}
var _valid0 = _errs97 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 6];
}
else {
if(_valid0){
valid0 = true;
passing0 = 6;
if(props0 !== true){
props0 = true;
}
}
const _errs116 = errors;
if(errors === _errs116){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing7;
if((((data.kind === undefined) && (missing7 = "kind")) || ((data.expected === undefined) && (missing7 = "expected"))) || ((data.current === undefined) && (missing7 = "current"))){
const err81 = {instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing7},message:"must have required property '"+missing7+"'"};
if(vErrors === null){
vErrors = [err81];
}
else {
vErrors.push(err81);
}
errors++;
}
else {
const _errs118 = errors;
for(const key7 in data){
if(!(((key7 === "current") || (key7 === "expected")) || (key7 === "kind"))){
const err82 = {instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err82];
}
else {
vErrors.push(err82);
}
errors++;
break;
}
}
if(_errs118 === errors){
if(data.current !== undefined){
const _errs119 = errors;
if(typeof data.current !== "string"){
const err83 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/7/properties/current/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err83];
}
else {
vErrors.push(err83);
}
errors++;
}
var valid30 = _errs119 === errors;
}
else {
var valid30 = true;
}
if(valid30){
if(data.expected !== undefined){
const _errs121 = errors;
if(typeof data.expected !== "string"){
const err84 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/7/properties/expected/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err84];
}
else {
vErrors.push(err84);
}
errors++;
}
var valid30 = _errs121 === errors;
}
else {
var valid30 = true;
}
if(valid30){
if(data.kind !== undefined){
let data23 = data.kind;
const _errs123 = errors;
if(typeof data23 !== "string"){
const err85 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err85];
}
else {
vErrors.push(err85);
}
errors++;
}
if("build-eligibility" !== data23){
const err86 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/const",keyword:"const",params:{allowedValue: "build-eligibility"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err86];
}
else {
vErrors.push(err86);
}
errors++;
}
var valid30 = _errs123 === errors;
}
else {
var valid30 = true;
}
}
}
}
}
}
else {
const err87 = {instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err87];
}
else {
vErrors.push(err87);
}
errors++;
}
}
var _valid0 = _errs116 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 7];
}
else {
if(_valid0){
valid0 = true;
passing0 = 7;
if(props0 !== true){
props0 = true;
}
}
const _errs125 = errors;
if(errors === _errs125){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing8;
if((((data.kind === undefined) && (missing8 = "kind")) || ((data.expected === undefined) && (missing8 = "expected"))) || ((data.current === undefined) && (missing8 = "current"))){
const err88 = {instancePath,schemaPath:"#/oneOf/8/required",keyword:"required",params:{missingProperty: missing8},message:"must have required property '"+missing8+"'"};
if(vErrors === null){
vErrors = [err88];
}
else {
vErrors.push(err88);
}
errors++;
}
else {
const _errs127 = errors;
for(const key8 in data){
if(!(((key8 === "current") || (key8 === "expected")) || (key8 === "kind"))){
const err89 = {instancePath,schemaPath:"#/oneOf/8/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err89];
}
else {
vErrors.push(err89);
}
errors++;
break;
}
}
if(_errs127 === errors){
if(data.current !== undefined){
const _errs128 = errors;
if(typeof data.current !== "string"){
const err90 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/8/properties/current/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err90];
}
else {
vErrors.push(err90);
}
errors++;
}
var valid31 = _errs128 === errors;
}
else {
var valid31 = true;
}
if(valid31){
if(data.expected !== undefined){
const _errs130 = errors;
if(typeof data.expected !== "string"){
const err91 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/8/properties/expected/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err91];
}
else {
vErrors.push(err91);
}
errors++;
}
var valid31 = _errs130 === errors;
}
else {
var valid31 = true;
}
if(valid31){
if(data.kind !== undefined){
let data26 = data.kind;
const _errs132 = errors;
if(typeof data26 !== "string"){
const err92 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/8/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err92];
}
else {
vErrors.push(err92);
}
errors++;
}
if("comparison-basis" !== data26){
const err93 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/8/properties/kind/const",keyword:"const",params:{allowedValue: "comparison-basis"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err93];
}
else {
vErrors.push(err93);
}
errors++;
}
var valid31 = _errs132 === errors;
}
else {
var valid31 = true;
}
}
}
}
}
}
else {
const err94 = {instancePath,schemaPath:"#/oneOf/8/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err94];
}
else {
vErrors.push(err94);
}
errors++;
}
}
var _valid0 = _errs125 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 8];
}
else {
if(_valid0){
valid0 = true;
passing0 = 8;
if(props0 !== true){
props0 = true;
}
}
const _errs134 = errors;
if(errors === _errs134){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing9;
if((((data.kind === undefined) && (missing9 = "kind")) || ((data.expected === undefined) && (missing9 = "expected"))) || ((data.current === undefined) && (missing9 = "current"))){
const err95 = {instancePath,schemaPath:"#/oneOf/9/required",keyword:"required",params:{missingProperty: missing9},message:"must have required property '"+missing9+"'"};
if(vErrors === null){
vErrors = [err95];
}
else {
vErrors.push(err95);
}
errors++;
}
else {
const _errs136 = errors;
for(const key9 in data){
if(!(((key9 === "current") || (key9 === "expected")) || (key9 === "kind"))){
const err96 = {instancePath,schemaPath:"#/oneOf/9/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err96];
}
else {
vErrors.push(err96);
}
errors++;
break;
}
}
if(_errs136 === errors){
if(data.current !== undefined){
let data27 = data.current;
const _errs137 = errors;
const _errs138 = errors;
let valid33 = false;
const _errs139 = errors;
const _errs140 = errors;
if(errors === _errs140){
if(typeof data27 === "string"){
if(!pattern4.test(data27)){
const err97 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err97];
}
else {
vErrors.push(err97);
}
errors++;
}
}
else {
const err98 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err98];
}
else {
vErrors.push(err98);
}
errors++;
}
}
var _valid11 = _errs139 === errors;
valid33 = valid33 || _valid11;
const _errs142 = errors;
if(data27 !== null){
const err99 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/9/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err99];
}
else {
vErrors.push(err99);
}
errors++;
}
var _valid11 = _errs142 === errors;
valid33 = valid33 || _valid11;
if(!valid33){
const err100 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/9/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err100];
}
else {
vErrors.push(err100);
}
errors++;
}
else {
errors = _errs138;
if(vErrors !== null){
if(_errs138){
vErrors.length = _errs138;
}
else {
vErrors = null;
}
}
}
var valid32 = _errs137 === errors;
}
else {
var valid32 = true;
}
if(valid32){
if(data.expected !== undefined){
let data28 = data.expected;
const _errs144 = errors;
const _errs145 = errors;
let valid35 = false;
const _errs146 = errors;
const _errs147 = errors;
if(errors === _errs147){
if(typeof data28 === "string"){
if(!pattern4.test(data28)){
const err101 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err101];
}
else {
vErrors.push(err101);
}
errors++;
}
}
else {
const err102 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err102];
}
else {
vErrors.push(err102);
}
errors++;
}
}
var _valid12 = _errs146 === errors;
valid35 = valid35 || _valid12;
const _errs149 = errors;
if(data28 !== null){
const err103 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/9/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err103];
}
else {
vErrors.push(err103);
}
errors++;
}
var _valid12 = _errs149 === errors;
valid35 = valid35 || _valid12;
if(!valid35){
const err104 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/9/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err104];
}
else {
vErrors.push(err104);
}
errors++;
}
else {
errors = _errs145;
if(vErrors !== null){
if(_errs145){
vErrors.length = _errs145;
}
else {
vErrors = null;
}
}
}
var valid32 = _errs144 === errors;
}
else {
var valid32 = true;
}
if(valid32){
if(data.kind !== undefined){
let data29 = data.kind;
const _errs151 = errors;
if(typeof data29 !== "string"){
const err105 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/9/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err105];
}
else {
vErrors.push(err105);
}
errors++;
}
if("term-revision" !== data29){
const err106 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/9/properties/kind/const",keyword:"const",params:{allowedValue: "term-revision"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err106];
}
else {
vErrors.push(err106);
}
errors++;
}
var valid32 = _errs151 === errors;
}
else {
var valid32 = true;
}
}
}
}
}
}
else {
const err107 = {instancePath,schemaPath:"#/oneOf/9/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err107];
}
else {
vErrors.push(err107);
}
errors++;
}
}
var _valid0 = _errs134 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 9];
}
else {
if(_valid0){
valid0 = true;
passing0 = 9;
if(props0 !== true){
props0 = true;
}
}
const _errs153 = errors;
if(errors === _errs153){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing10;
if((((data.kind === undefined) && (missing10 = "kind")) || ((data.expected === undefined) && (missing10 = "expected"))) || ((data.current === undefined) && (missing10 = "current"))){
const err108 = {instancePath,schemaPath:"#/oneOf/10/required",keyword:"required",params:{missingProperty: missing10},message:"must have required property '"+missing10+"'"};
if(vErrors === null){
vErrors = [err108];
}
else {
vErrors.push(err108);
}
errors++;
}
else {
const _errs155 = errors;
for(const key10 in data){
if(!(((key10 === "current") || (key10 === "expected")) || (key10 === "kind"))){
const err109 = {instancePath,schemaPath:"#/oneOf/10/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key10},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err109];
}
else {
vErrors.push(err109);
}
errors++;
break;
}
}
if(_errs155 === errors){
if(data.current !== undefined){
let data30 = data.current;
const _errs156 = errors;
const _errs157 = errors;
let valid38 = false;
const _errs158 = errors;
const _errs159 = errors;
if(errors === _errs159){
if(typeof data30 === "string"){
if(!pattern4.test(data30)){
const err110 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err110];
}
else {
vErrors.push(err110);
}
errors++;
}
}
else {
const err111 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err111];
}
else {
vErrors.push(err111);
}
errors++;
}
}
var _valid13 = _errs158 === errors;
valid38 = valid38 || _valid13;
const _errs161 = errors;
if(data30 !== null){
const err112 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/10/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err112];
}
else {
vErrors.push(err112);
}
errors++;
}
var _valid13 = _errs161 === errors;
valid38 = valid38 || _valid13;
if(!valid38){
const err113 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/10/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err113];
}
else {
vErrors.push(err113);
}
errors++;
}
else {
errors = _errs157;
if(vErrors !== null){
if(_errs157){
vErrors.length = _errs157;
}
else {
vErrors = null;
}
}
}
var valid37 = _errs156 === errors;
}
else {
var valid37 = true;
}
if(valid37){
if(data.expected !== undefined){
let data31 = data.expected;
const _errs163 = errors;
const _errs164 = errors;
let valid40 = false;
const _errs165 = errors;
const _errs166 = errors;
if(errors === _errs166){
if(typeof data31 === "string"){
if(!pattern4.test(data31)){
const err114 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err114];
}
else {
vErrors.push(err114);
}
errors++;
}
}
else {
const err115 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err115];
}
else {
vErrors.push(err115);
}
errors++;
}
}
var _valid14 = _errs165 === errors;
valid40 = valid40 || _valid14;
const _errs168 = errors;
if(data31 !== null){
const err116 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/10/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err116];
}
else {
vErrors.push(err116);
}
errors++;
}
var _valid14 = _errs168 === errors;
valid40 = valid40 || _valid14;
if(!valid40){
const err117 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/10/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err117];
}
else {
vErrors.push(err117);
}
errors++;
}
else {
errors = _errs164;
if(vErrors !== null){
if(_errs164){
vErrors.length = _errs164;
}
else {
vErrors = null;
}
}
}
var valid37 = _errs163 === errors;
}
else {
var valid37 = true;
}
if(valid37){
if(data.kind !== undefined){
let data32 = data.kind;
const _errs170 = errors;
if(typeof data32 !== "string"){
const err118 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/10/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err118];
}
else {
vErrors.push(err118);
}
errors++;
}
if("context-revision" !== data32){
const err119 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/10/properties/kind/const",keyword:"const",params:{allowedValue: "context-revision"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err119];
}
else {
vErrors.push(err119);
}
errors++;
}
var valid37 = _errs170 === errors;
}
else {
var valid37 = true;
}
}
}
}
}
}
else {
const err120 = {instancePath,schemaPath:"#/oneOf/10/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err120];
}
else {
vErrors.push(err120);
}
errors++;
}
}
var _valid0 = _errs153 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 10];
}
else {
if(_valid0){
valid0 = true;
passing0 = 10;
if(props0 !== true){
props0 = true;
}
}
const _errs172 = errors;
if(errors === _errs172){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing11;
if((((data.kind === undefined) && (missing11 = "kind")) || ((data.expected === undefined) && (missing11 = "expected"))) || ((data.current === undefined) && (missing11 = "current"))){
const err121 = {instancePath,schemaPath:"#/oneOf/11/required",keyword:"required",params:{missingProperty: missing11},message:"must have required property '"+missing11+"'"};
if(vErrors === null){
vErrors = [err121];
}
else {
vErrors.push(err121);
}
errors++;
}
else {
const _errs174 = errors;
for(const key11 in data){
if(!(((key11 === "current") || (key11 === "expected")) || (key11 === "kind"))){
const err122 = {instancePath,schemaPath:"#/oneOf/11/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key11},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err122];
}
else {
vErrors.push(err122);
}
errors++;
break;
}
}
if(_errs174 === errors){
if(data.current !== undefined){
let data33 = data.current;
const _errs175 = errors;
const _errs176 = errors;
let valid43 = false;
const _errs177 = errors;
const _errs178 = errors;
if(errors === _errs178){
if(typeof data33 === "string"){
if(!pattern4.test(data33)){
const err123 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err123];
}
else {
vErrors.push(err123);
}
errors++;
}
}
else {
const err124 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err124];
}
else {
vErrors.push(err124);
}
errors++;
}
}
var _valid15 = _errs177 === errors;
valid43 = valid43 || _valid15;
const _errs180 = errors;
if(data33 !== null){
const err125 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/11/properties/current/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err125];
}
else {
vErrors.push(err125);
}
errors++;
}
var _valid15 = _errs180 === errors;
valid43 = valid43 || _valid15;
if(!valid43){
const err126 = {instancePath:instancePath+"/current",schemaPath:"#/oneOf/11/properties/current/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err126];
}
else {
vErrors.push(err126);
}
errors++;
}
else {
errors = _errs176;
if(vErrors !== null){
if(_errs176){
vErrors.length = _errs176;
}
else {
vErrors = null;
}
}
}
var valid42 = _errs175 === errors;
}
else {
var valid42 = true;
}
if(valid42){
if(data.expected !== undefined){
let data34 = data.expected;
const _errs182 = errors;
const _errs183 = errors;
let valid45 = false;
const _errs184 = errors;
const _errs185 = errors;
if(errors === _errs185){
if(typeof data34 === "string"){
if(!pattern4.test(data34)){
const err127 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err127];
}
else {
vErrors.push(err127);
}
errors++;
}
}
else {
const err128 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err128];
}
else {
vErrors.push(err128);
}
errors++;
}
}
var _valid16 = _errs184 === errors;
valid45 = valid45 || _valid16;
const _errs187 = errors;
if(data34 !== null){
const err129 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/11/properties/expected/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err129];
}
else {
vErrors.push(err129);
}
errors++;
}
var _valid16 = _errs187 === errors;
valid45 = valid45 || _valid16;
if(!valid45){
const err130 = {instancePath:instancePath+"/expected",schemaPath:"#/oneOf/11/properties/expected/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err130];
}
else {
vErrors.push(err130);
}
errors++;
}
else {
errors = _errs183;
if(vErrors !== null){
if(_errs183){
vErrors.length = _errs183;
}
else {
vErrors = null;
}
}
}
var valid42 = _errs182 === errors;
}
else {
var valid42 = true;
}
if(valid42){
if(data.kind !== undefined){
let data35 = data.kind;
const _errs189 = errors;
if(typeof data35 !== "string"){
const err131 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/11/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err131];
}
else {
vErrors.push(err131);
}
errors++;
}
if("source-snapshot" !== data35){
const err132 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/11/properties/kind/const",keyword:"const",params:{allowedValue: "source-snapshot"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err132];
}
else {
vErrors.push(err132);
}
errors++;
}
var valid42 = _errs189 === errors;
}
else {
var valid42 = true;
}
}
}
}
}
}
else {
const err133 = {instancePath,schemaPath:"#/oneOf/11/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err133];
}
else {
vErrors.push(err133);
}
errors++;
}
}
var _valid0 = _errs172 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 11];
}
else {
if(_valid0){
valid0 = true;
passing0 = 11;
if(props0 !== true){
props0 = true;
}
}
const _errs191 = errors;
if(errors === _errs191){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing12;
if((((data.kind === undefined) && (missing12 = "kind")) || ((data.expected === undefined) && (missing12 = "expected"))) || ((data.current === undefined) && (missing12 = "current"))){
const err134 = {instancePath,schemaPath:"#/oneOf/12/required",keyword:"required",params:{missingProperty: missing12},message:"must have required property '"+missing12+"'"};
if(vErrors === null){
vErrors = [err134];
}
else {
vErrors.push(err134);
}
errors++;
}
else {
const _errs193 = errors;
for(const key12 in data){
if(!(((key12 === "current") || (key12 === "expected")) || (key12 === "kind"))){
const err135 = {instancePath,schemaPath:"#/oneOf/12/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key12},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err135];
}
else {
vErrors.push(err135);
}
errors++;
break;
}
}
if(_errs193 === errors){
if(data.current !== undefined){
let data36 = data.current;
const _errs194 = errors;
const _errs195 = errors;
if(errors === _errs195){
if(typeof data36 === "string"){
if(!pattern37.test(data36)){
const err136 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/Revision/pattern",keyword:"pattern",params:{pattern: "^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$"},message:"must match pattern \""+"^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$"+"\""};
if(vErrors === null){
vErrors = [err136];
}
else {
vErrors.push(err136);
}
errors++;
}
}
else {
const err137 = {instancePath:instancePath+"/current",schemaPath:"#/$defs/Revision/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err137];
}
else {
vErrors.push(err137);
}
errors++;
}
}
var valid47 = _errs194 === errors;
}
else {
var valid47 = true;
}
if(valid47){
if(data.expected !== undefined){
let data37 = data.expected;
const _errs197 = errors;
const _errs198 = errors;
if(errors === _errs198){
if(typeof data37 === "string"){
if(!pattern37.test(data37)){
const err138 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/Revision/pattern",keyword:"pattern",params:{pattern: "^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$"},message:"must match pattern \""+"^(0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-6][0-9]{0}|9223372036854775807)$"+"\""};
if(vErrors === null){
vErrors = [err138];
}
else {
vErrors.push(err138);
}
errors++;
}
}
else {
const err139 = {instancePath:instancePath+"/expected",schemaPath:"#/$defs/Revision/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err139];
}
else {
vErrors.push(err139);
}
errors++;
}
}
var valid47 = _errs197 === errors;
}
else {
var valid47 = true;
}
if(valid47){
if(data.kind !== undefined){
let data38 = data.kind;
const _errs200 = errors;
if(typeof data38 !== "string"){
const err140 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/12/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err140];
}
else {
vErrors.push(err140);
}
errors++;
}
if("content-revision" !== data38){
const err141 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/12/properties/kind/const",keyword:"const",params:{allowedValue: "content-revision"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err141];
}
else {
vErrors.push(err141);
}
errors++;
}
var valid47 = _errs200 === errors;
}
else {
var valid47 = true;
}
}
}
}
}
}
else {
const err142 = {instancePath,schemaPath:"#/oneOf/12/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err142];
}
else {
vErrors.push(err142);
}
errors++;
}
}
var _valid0 = _errs191 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 12];
}
else {
if(_valid0){
valid0 = true;
passing0 = 12;
if(props0 !== true){
props0 = true;
}
}
}
}
}
}
}
}
}
}
}
}
}
}
if(!valid0){
const err143 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err143];
}
else {
vErrors.push(err143);
}
errors++;
validate32.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate32.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate32.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate31(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate31.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.code === undefined) && (missing0 = "code")) || ((data.stage === undefined) && (missing0 = "stage"))) || ((data.itemIds === undefined) && (missing0 = "itemIds"))){
validate31.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "code") || (key0 === "conflict")) || (key0 === "itemIds")) || (key0 === "stage"))){
validate31.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.code !== undefined){
let data0 = data.code;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate31.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/ErrorCode/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((((((((((data0 === "invalid-input") || (data0 === "limit-exceeded")) || (data0 === "result-mismatch")) || (data0 === "output-invalid")) || (data0 === "dependency-conflict")) || (data0 === "cancelled")) || (data0 === "outcome-unknown")) || (data0 === "unauthorized")) || (data0 === "busy")) || (data0 === "storage-failed")) || (data0 === "corrupt-ledger"))){
validate31.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/ErrorCode/enum",keyword:"enum",params:{allowedValues: schema57.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.conflict !== undefined){
let data1 = data.conflict;
const _errs5 = errors;
const _errs6 = errors;
let valid2 = false;
const _errs7 = errors;
if(!(validate32(data1, {instancePath:instancePath+"/conflict",parentData:data,parentDataProperty:"conflict",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate32.errors : vErrors.concat(validate32.errors);
errors = vErrors.length;
}
var _valid0 = _errs7 === errors;
valid2 = valid2 || _valid0;
const _errs8 = errors;
if(data1 !== null){
const err0 = {instancePath:instancePath+"/conflict",schemaPath:"#/properties/conflict/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs8 === errors;
valid2 = valid2 || _valid0;
if(!valid2){
const err1 = {instancePath:instancePath+"/conflict",schemaPath:"#/properties/conflict/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
validate31.errors = vErrors;
return false;
}
else {
errors = _errs6;
if(vErrors !== null){
if(_errs6){
vErrors.length = _errs6;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.itemIds !== undefined){
let data2 = data.itemIds;
const _errs10 = errors;
if(errors === _errs10){
if(Array.isArray(data2)){
var valid3 = true;
const len0 = data2.length;
for(let i0=0; i0<len0; i0++){
let data3 = data2[i0];
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(typeof data3 === "string"){
if(!pattern4.test(data3)){
validate31.errors = [{instancePath:instancePath+"/itemIds/" + i0,schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""}];
return false;
}
}
else {
validate31.errors = [{instancePath:instancePath+"/itemIds/" + i0,schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid3 = _errs12 === errors;
if(!valid3){
break;
}
}
}
else {
validate31.errors = [{instancePath:instancePath+"/itemIds",schemaPath:"#/properties/itemIds/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.stage !== undefined){
const _errs15 = errors;
if(typeof data.stage !== "string"){
validate31.errors = [{instancePath:instancePath+"/stage",schemaPath:"#/properties/stage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
else {
validate31.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate31.errors = vErrors;
return errors === 0;
}
validate31.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate28(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate28.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.kind === undefined) && (missing0 = "kind")) || ((data.requestId === undefined) && (missing0 = "requestId"))) || ((data.sharedView === undefined) && (missing0 = "sharedView"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!(((key0 === "kind") || (key0 === "requestId")) || (key0 === "sharedView"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.kind !== undefined){
let data0 = data.kind;
const _errs4 = errors;
if(typeof data0 !== "string"){
const err2 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("prepared" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "prepared"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.requestId !== undefined){
let data1 = data.requestId;
const _errs6 = errors;
const _errs7 = errors;
if(errors === _errs7){
if(typeof data1 === "string"){
if(!pattern4.test(data1)){
const err4 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
else {
const err5 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.sharedView !== undefined){
let data2 = data.sharedView;
const _errs9 = errors;
const _errs10 = errors;
let valid3 = false;
const _errs11 = errors;
if(!(validate29(data2, {instancePath:instancePath+"/sharedView",parentData:data,parentDataProperty:"sharedView",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate29.errors : vErrors.concat(validate29.errors);
errors = vErrors.length;
}
var _valid1 = _errs11 === errors;
valid3 = valid3 || _valid1;
const _errs12 = errors;
if(data2 !== null){
const err6 = {instancePath:instancePath+"/sharedView",schemaPath:"#/oneOf/0/properties/sharedView/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
var _valid1 = _errs12 === errors;
valid3 = valid3 || _valid1;
if(!valid3){
const err7 = {instancePath:instancePath+"/sharedView",schemaPath:"#/oneOf/0/properties/sharedView/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
errors = _errs10;
if(vErrors !== null){
if(_errs10){
vErrors.length = _errs10;
}
else {
vErrors = null;
}
}
}
var valid1 = _errs9 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
}
else {
const err8 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props1 = true;
}
const _errs14 = errors;
if(errors === _errs14){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if((((((data.kind === undefined) && (missing1 = "kind")) || ((data.requestId === undefined) && (missing1 = "requestId"))) || ((data.status === undefined) && (missing1 = "status"))) || ((data.contentType === undefined) && (missing1 = "contentType"))) || ((data.body === undefined) && (missing1 = "body"))){
const err9 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
else {
const _errs16 = errors;
for(const key1 in data){
if(!(((((key1 === "body") || (key1 === "contentType")) || (key1 === "kind")) || (key1 === "requestId")) || (key1 === "status"))){
const err10 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
break;
}
}
if(_errs16 === errors){
if(data.body !== undefined){
const _errs17 = errors;
if(typeof data.body !== "string"){
const err11 = {instancePath:instancePath+"/body",schemaPath:"#/oneOf/1/properties/body/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
var valid4 = _errs17 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.contentType !== undefined){
let data4 = data.contentType;
const _errs19 = errors;
if((typeof data4 !== "string") && (data4 !== null)){
const err12 = {instancePath:instancePath+"/contentType",schemaPath:"#/oneOf/1/properties/contentType/type",keyword:"type",params:{type: schema50.oneOf[1].properties.contentType.type},message:"must be string,null"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs21 = errors;
if(typeof data5 !== "string"){
const err13 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
if("http" !== data5){
const err14 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "http"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.requestId !== undefined){
let data6 = data.requestId;
const _errs23 = errors;
const _errs24 = errors;
if(errors === _errs24){
if(typeof data6 === "string"){
if(!pattern4.test(data6)){
const err15 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
else {
const err16 = {instancePath:instancePath+"/requestId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
var valid4 = _errs23 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.status !== undefined){
let data7 = data.status;
const _errs26 = errors;
if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){
const err17 = {instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if(errors === _errs26){
if((typeof data7 == "number") && (isFinite(data7))){
if(data7 > 65535 || isNaN(data7)){
const err18 = {instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535},message:"must be <= 65535"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
else {
if(data7 < 0 || isNaN(data7)){
const err19 = {instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
}
}
var valid4 = _errs26 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
}
}
else {
const err20 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
var _valid0 = _errs14 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props1 !== true){
props1 = true;
}
}
const _errs28 = errors;
if(errors === _errs28){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if((((data.kind === undefined) && (missing2 = "kind")) || ((data.block === undefined) && (missing2 = "block"))) || ((data.reason === undefined) && (missing2 = "reason"))){
const err21 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
else {
const _errs30 = errors;
for(const key2 in data){
if(!(((key2 === "block") || (key2 === "kind")) || (key2 === "reason"))){
const err22 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
break;
}
}
if(_errs30 === errors){
if(data.block !== undefined){
const _errs31 = errors;
if(typeof data.block !== "boolean"){
const err23 = {instancePath:instancePath+"/block",schemaPath:"#/oneOf/2/properties/block/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
var valid6 = _errs31 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.kind !== undefined){
let data9 = data.kind;
const _errs33 = errors;
if(typeof data9 !== "string"){
const err24 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
if("tool-admission" !== data9){
const err25 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "tool-admission"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
var valid6 = _errs33 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.reason !== undefined){
let data10 = data.reason;
const _errs35 = errors;
if((typeof data10 !== "string") && (data10 !== null)){
const err26 = {instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: schema50.oneOf[2].properties.reason.type},message:"must be string,null"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
var valid6 = _errs35 === errors;
}
else {
var valid6 = true;
}
}
}
}
}
}
else {
const err27 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
}
var _valid0 = _errs28 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 2];
}
else {
if(_valid0){
valid0 = true;
passing0 = 2;
if(props1 !== true){
props1 = true;
}
}
const _errs37 = errors;
if(errors === _errs37){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing3;
if(((((data.kind === undefined) && (missing3 = "kind")) || ((data.content === undefined) && (missing3 = "content"))) || ((data.details === undefined) && (missing3 = "details"))) || ((data.isError === undefined) && (missing3 = "isError"))){
const err28 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
else {
const _errs39 = errors;
for(const key3 in data){
if(!((((key3 === "content") || (key3 === "details")) || (key3 === "isError")) || (key3 === "kind"))){
const err29 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
break;
}
}
if(_errs39 === errors){
if(data.isError !== undefined){
const _errs40 = errors;
if(typeof data.isError !== "boolean"){
const err30 = {instancePath:instancePath+"/isError",schemaPath:"#/oneOf/3/properties/isError/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
var valid7 = _errs40 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data.kind !== undefined){
let data12 = data.kind;
const _errs42 = errors;
if(typeof data12 !== "string"){
const err31 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
if("tool-result" !== data12){
const err32 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "tool-result"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
var valid7 = _errs42 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
else {
const err33 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
}
var _valid0 = _errs37 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 3];
}
else {
if(_valid0){
valid0 = true;
passing0 = 3;
if(props1 !== true){
props1 = true;
}
}
const _errs44 = errors;
if(errors === _errs44){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if((((data.kind === undefined) && (missing4 = "kind")) || ((data.content === undefined) && (missing4 = "content"))) || ((data.isError === undefined) && (missing4 = "isError"))){
const err34 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
else {
const _errs46 = errors;
for(const key4 in data){
if(!(((key4 === "content") || (key4 === "isError")) || (key4 === "kind"))){
const err35 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
break;
}
}
if(_errs46 === errors){
if(data.isError !== undefined){
let data13 = data.isError;
const _errs47 = errors;
if((typeof data13 !== "boolean") && (data13 !== null)){
const err36 = {instancePath:instancePath+"/isError",schemaPath:"#/oneOf/4/properties/isError/type",keyword:"type",params:{type: schema50.oneOf[4].properties.isError.type},message:"must be boolean,null"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
var valid8 = _errs47 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.kind !== undefined){
let data14 = data.kind;
const _errs49 = errors;
if(typeof data14 !== "string"){
const err37 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
if("tool-finalized" !== data14){
const err38 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "tool-finalized"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
var valid8 = _errs49 === errors;
}
else {
var valid8 = true;
}
}
}
}
}
else {
const err39 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
}
var _valid0 = _errs44 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 4];
}
else {
if(_valid0){
valid0 = true;
passing0 = 4;
if(props1 !== true){
props1 = true;
}
}
const _errs51 = errors;
if(errors === _errs51){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if(((data.kind === undefined) && (missing5 = "kind")) || ((data.action === undefined) && (missing5 = "action"))){
const err40 = {instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
else {
const _errs53 = errors;
for(const key5 in data){
if(!((key5 === "action") || (key5 === "kind"))){
const err41 = {instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
break;
}
}
if(_errs53 === errors){
if(data.action !== undefined){
let data15 = data.action;
const _errs54 = errors;
if(typeof data15 !== "string"){
const err42 = {instancePath:instancePath+"/action",schemaPath:"#/$defs/TurnAction/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
if(!(((data15 === "normal") || (data15 === "end")) || (data15 === "continue"))){
const err43 = {instancePath:instancePath+"/action",schemaPath:"#/$defs/TurnAction/enum",keyword:"enum",params:{allowedValues: schema55.enum},message:"must be equal to one of the allowed values"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
var valid9 = _errs54 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data.kind !== undefined){
let data16 = data.kind;
const _errs57 = errors;
if(typeof data16 !== "string"){
const err44 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
if("turn" !== data16){
const err45 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "turn"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
var valid9 = _errs57 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
else {
const err46 = {instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
}
var _valid0 = _errs51 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 5];
}
else {
if(_valid0){
valid0 = true;
passing0 = 5;
if(props1 !== true){
props1 = true;
}
}
const _errs59 = errors;
if(errors === _errs59){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing6;
if((data.kind === undefined) && (missing6 = "kind")){
const err47 = {instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6},message:"must have required property '"+missing6+"'"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
else {
const _errs61 = errors;
for(const key6 in data){
if(!(key6 === "kind")){
const err48 = {instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
break;
}
}
if(_errs61 === errors){
if(data.kind !== undefined){
let data17 = data.kind;
if(typeof data17 !== "string"){
const err49 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
if("recorded" !== data17){
const err50 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "recorded"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
}
}
}
}
else {
const err51 = {instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
}
var _valid0 = _errs59 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 6];
}
else {
if(_valid0){
valid0 = true;
passing0 = 6;
if(props1 !== true){
props1 = true;
}
}
const _errs64 = errors;
if(errors === _errs64){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing7;
if(((data.kind === undefined) && (missing7 = "kind")) || ((data.error === undefined) && (missing7 = "error"))){
const err52 = {instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing7},message:"must have required property '"+missing7+"'"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
else {
const _errs66 = errors;
for(const key7 in data){
if(!((key7 === "error") || (key7 === "kind"))){
const err53 = {instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
break;
}
}
if(_errs66 === errors){
if(data.error !== undefined){
const _errs67 = errors;
if(!(validate31(data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate31.errors : vErrors.concat(validate31.errors);
errors = vErrors.length;
}
var valid12 = _errs67 === errors;
}
else {
var valid12 = true;
}
if(valid12){
if(data.kind !== undefined){
let data19 = data.kind;
const _errs68 = errors;
if(typeof data19 !== "string"){
const err54 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
if("rejected" !== data19){
const err55 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/const",keyword:"const",params:{allowedValue: "rejected"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err55];
}
else {
vErrors.push(err55);
}
errors++;
}
var valid12 = _errs68 === errors;
}
else {
var valid12 = true;
}
}
}
}
}
else {
const err56 = {instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err56];
}
else {
vErrors.push(err56);
}
errors++;
}
}
var _valid0 = _errs64 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 7];
}
else {
if(_valid0){
valid0 = true;
passing0 = 7;
if(props1 !== true){
props1 = true;
}
}
}
}
}
}
}
}
}
if(!valid0){
const err57 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err57];
}
else {
vErrors.push(err57);
}
errors++;
validate28.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate28.errors = vErrors;
evaluated0.props = props1;
return errors === 0;
}
validate28.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate21(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate21.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.memberId === undefined) && (missing0 = "memberId"))) || ((data.workItemId === undefined) && (missing0 = "workItemId"))) || ((data.contextVersion === undefined) && (missing0 = "contextVersion"))) || ((data.profile === undefined) && (missing0 = "profile"))) || ((data.systemPrompt === undefined) && (missing0 = "systemPrompt"))) || ((data.context === undefined) && (missing0 = "context"))) || ((data.input === undefined) && (missing0 = "input"))) || ((data.tools === undefined) && (missing0 = "tools"))) || ((data.maxTurns === undefined) && (missing0 = "maxTurns"))) || ((data.timeoutMs === undefined) && (missing0 = "timeoutMs"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!(func1.call(schema32.oneOf[0].properties, key0))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.contextVersion !== undefined){
const _errs4 = errors;
if(typeof data.contextVersion !== "string"){
const err2 = {instancePath:instancePath+"/contextVersion",schemaPath:"#/oneOf/0/properties/contextVersion/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.input !== undefined){
const _errs6 = errors;
if(typeof data.input !== "string"){
const err3 = {instancePath:instancePath+"/input",schemaPath:"#/oneOf/0/properties/input/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.kind !== undefined){
let data2 = data.kind;
const _errs8 = errors;
if(typeof data2 !== "string"){
const err4 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if("start" !== data2){
const err5 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "start"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid1 = _errs8 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.maxTurns !== undefined){
let data3 = data.maxTurns;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
const err6 = {instancePath:instancePath+"/maxTurns",schemaPath:"#/oneOf/0/properties/maxTurns/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
const err7 = {instancePath:instancePath+"/maxTurns",schemaPath:"#/oneOf/0/properties/maxTurns/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data3 < 0 || isNaN(data3)){
const err8 = {instancePath:instancePath+"/maxTurns",schemaPath:"#/oneOf/0/properties/maxTurns/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
}
}
var valid1 = _errs10 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.memberId !== undefined){
let data4 = data.memberId;
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(typeof data4 === "string"){
if(!pattern4.test(data4)){
const err9 = {instancePath:instancePath+"/memberId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
else {
const err10 = {instancePath:instancePath+"/memberId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
}
var valid1 = _errs12 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.profile !== undefined){
const _errs15 = errors;
if(!(validate22(data.profile, {instancePath:instancePath+"/profile",parentData:data,parentDataProperty:"profile",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
errors = vErrors.length;
}
var valid1 = _errs15 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.systemPrompt !== undefined){
const _errs16 = errors;
if(typeof data.systemPrompt !== "string"){
const err11 = {instancePath:instancePath+"/systemPrompt",schemaPath:"#/oneOf/0/properties/systemPrompt/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
var valid1 = _errs16 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.timeoutMs !== undefined){
let data7 = data.timeoutMs;
const _errs18 = errors;
if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){
const err12 = {instancePath:instancePath+"/timeoutMs",schemaPath:"#/oneOf/0/properties/timeoutMs/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
if(errors === _errs18){
if((typeof data7 == "number") && (isFinite(data7))){
if(data7 > 4294967295 || isNaN(data7)){
const err13 = {instancePath:instancePath+"/timeoutMs",schemaPath:"#/oneOf/0/properties/timeoutMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
else {
if(data7 < 0 || isNaN(data7)){
const err14 = {instancePath:instancePath+"/timeoutMs",schemaPath:"#/oneOf/0/properties/timeoutMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
}
}
var valid1 = _errs18 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.tools !== undefined){
let data8 = data.tools;
const _errs20 = errors;
if(errors === _errs20){
if(Array.isArray(data8)){
var valid3 = true;
const len0 = data8.length;
for(let i0=0; i0<len0; i0++){
let data9 = data8[i0];
const _errs22 = errors;
const _errs23 = errors;
if(errors === _errs23){
if(data9 && typeof data9 == "object" && !Array.isArray(data9)){
let missing1;
if((((data9.name === undefined) && (missing1 = "name")) || ((data9.description === undefined) && (missing1 = "description"))) || ((data9.parameters === undefined) && (missing1 = "parameters"))){
const err15 = {instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/MemberTool/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
const _errs25 = errors;
for(const key1 in data9){
if(!(((key1 === "description") || (key1 === "name")) || (key1 === "parameters"))){
const err16 = {instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/MemberTool/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
break;
}
}
if(_errs25 === errors){
if(data9.description !== undefined){
const _errs26 = errors;
if(typeof data9.description !== "string"){
const err17 = {instancePath:instancePath+"/tools/" + i0+"/description",schemaPath:"#/$defs/MemberTool/properties/description/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
var valid5 = _errs26 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data9.name !== undefined){
const _errs28 = errors;
if(typeof data9.name !== "string"){
const err18 = {instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/MemberTool/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
var valid5 = _errs28 === errors;
}
else {
var valid5 = true;
}
}
}
}
}
else {
const err19 = {instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/MemberTool/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
var valid3 = _errs22 === errors;
if(!valid3){
break;
}
}
}
else {
const err20 = {instancePath:instancePath+"/tools",schemaPath:"#/oneOf/0/properties/tools/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
var valid1 = _errs20 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.workItemId !== undefined){
let data12 = data.workItemId;
const _errs30 = errors;
const _errs31 = errors;
if(errors === _errs31){
if(typeof data12 === "string"){
if(!pattern4.test(data12)){
const err21 = {instancePath:instancePath+"/workItemId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
}
else {
const err22 = {instancePath:instancePath+"/workItemId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
}
var valid1 = _errs30 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
}
}
}
}
}
}
}
}
else {
const err23 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs33 = errors;
if(errors === _errs33){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if((data.kind === undefined) && (missing2 = "kind")){
const err24 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
else {
const _errs35 = errors;
for(const key2 in data){
if(!(key2 === "kind")){
const err25 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
break;
}
}
if(_errs35 === errors){
if(data.kind !== undefined){
let data13 = data.kind;
if(typeof data13 !== "string"){
const err26 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
if("ready" !== data13){
const err27 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "ready"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
}
}
}
}
else {
const err28 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
}
var _valid0 = _errs33 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
const _errs38 = errors;
if(errors === _errs38){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing3;
if((((data.kind === undefined) && (missing3 = "kind")) || ((data.request === undefined) && (missing3 = "request"))) || ((data.call === undefined) && (missing3 = "call"))){
const err29 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
else {
const _errs40 = errors;
for(const key3 in data){
if(!(((key3 === "call") || (key3 === "kind")) || (key3 === "request"))){
const err30 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
break;
}
}
if(_errs40 === errors){
if(data.call !== undefined){
const _errs41 = errors;
if(!(validate24(data.call, {instancePath:instancePath+"/call",parentData:data,parentDataProperty:"call",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate24.errors : vErrors.concat(validate24.errors);
errors = vErrors.length;
}
var valid8 = _errs41 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.kind !== undefined){
let data15 = data.kind;
const _errs42 = errors;
if(typeof data15 !== "string"){
const err31 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
if("request" !== data15){
const err32 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "request"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
var valid8 = _errs42 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data.request !== undefined){
let data16 = data.request;
const _errs44 = errors;
if(!(((typeof data16 == "number") && (!(data16 % 1) && !isNaN(data16))) && (isFinite(data16)))){
const err33 = {instancePath:instancePath+"/request",schemaPath:"#/oneOf/2/properties/request/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
if(errors === _errs44){
if((typeof data16 == "number") && (isFinite(data16))){
if(data16 > 4294967295 || isNaN(data16)){
const err34 = {instancePath:instancePath+"/request",schemaPath:"#/oneOf/2/properties/request/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
else {
if(data16 < 0 || isNaN(data16)){
const err35 = {instancePath:instancePath+"/request",schemaPath:"#/oneOf/2/properties/request/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
}
}
}
var valid8 = _errs44 === errors;
}
else {
var valid8 = true;
}
}
}
}
}
}
else {
const err36 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
}
var _valid0 = _errs38 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 2];
}
else {
if(_valid0){
valid0 = true;
passing0 = 2;
if(props0 !== true){
props0 = true;
}
}
const _errs46 = errors;
if(errors === _errs46){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if((((data.kind === undefined) && (missing4 = "kind")) || ((data.request === undefined) && (missing4 = "request"))) || ((data.reply === undefined) && (missing4 = "reply"))){
const err37 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
else {
const _errs48 = errors;
for(const key4 in data){
if(!(((key4 === "kind") || (key4 === "reply")) || (key4 === "request"))){
const err38 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
break;
}
}
if(_errs48 === errors){
if(data.kind !== undefined){
let data17 = data.kind;
const _errs49 = errors;
if(typeof data17 !== "string"){
const err39 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
if("reply" !== data17){
const err40 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "reply"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
}
var valid9 = _errs49 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data.reply !== undefined){
const _errs51 = errors;
if(!(validate28(data.reply, {instancePath:instancePath+"/reply",parentData:data,parentDataProperty:"reply",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate28.errors : vErrors.concat(validate28.errors);
errors = vErrors.length;
}
var valid9 = _errs51 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data.request !== undefined){
let data19 = data.request;
const _errs52 = errors;
if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){
const err41 = {instancePath:instancePath+"/request",schemaPath:"#/oneOf/3/properties/request/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
if(errors === _errs52){
if((typeof data19 == "number") && (isFinite(data19))){
if(data19 > 4294967295 || isNaN(data19)){
const err42 = {instancePath:instancePath+"/request",schemaPath:"#/oneOf/3/properties/request/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
}
else {
if(data19 < 0 || isNaN(data19)){
const err43 = {instancePath:instancePath+"/request",schemaPath:"#/oneOf/3/properties/request/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};
if(vErrors === null){
vErrors = [err43];
}
else {
vErrors.push(err43);
}
errors++;
}
}
}
}
var valid9 = _errs52 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
}
else {
const err44 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
}
var _valid0 = _errs46 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 3];
}
else {
if(_valid0){
valid0 = true;
passing0 = 3;
if(props0 !== true){
props0 = true;
}
}
const _errs54 = errors;
if(errors === _errs54){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if(((data.kind === undefined) && (missing5 = "kind")) || ((data.text === undefined) && (missing5 = "text"))){
const err45 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
else {
const _errs56 = errors;
for(const key5 in data){
if(!((key5 === "kind") || (key5 === "text"))){
const err46 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
break;
}
}
if(_errs56 === errors){
if(data.kind !== undefined){
let data20 = data.kind;
const _errs57 = errors;
if(typeof data20 !== "string"){
const err47 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
if("guide" !== data20){
const err48 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "guide"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
var valid10 = _errs57 === errors;
}
else {
var valid10 = true;
}
if(valid10){
if(data.text !== undefined){
const _errs59 = errors;
if(typeof data.text !== "string"){
const err49 = {instancePath:instancePath+"/text",schemaPath:"#/oneOf/4/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
}
var valid10 = _errs59 === errors;
}
else {
var valid10 = true;
}
}
}
}
}
else {
const err50 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
}
var _valid0 = _errs54 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 4];
}
else {
if(_valid0){
valid0 = true;
passing0 = 4;
if(props0 !== true){
props0 = true;
}
}
const _errs61 = errors;
if(errors === _errs61){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing6;
if((data.kind === undefined) && (missing6 = "kind")){
const err51 = {instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing6},message:"must have required property '"+missing6+"'"};
if(vErrors === null){
vErrors = [err51];
}
else {
vErrors.push(err51);
}
errors++;
}
else {
const _errs63 = errors;
for(const key6 in data){
if(!(key6 === "kind")){
const err52 = {instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
break;
}
}
if(_errs63 === errors){
if(data.kind !== undefined){
let data22 = data.kind;
if(typeof data22 !== "string"){
const err53 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
if("close" !== data22){
const err54 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "close"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
}
}
}
}
else {
const err55 = {instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err55];
}
else {
vErrors.push(err55);
}
errors++;
}
}
var _valid0 = _errs61 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 5];
}
else {
if(_valid0){
valid0 = true;
passing0 = 5;
if(props0 !== true){
props0 = true;
}
}
const _errs66 = errors;
if(errors === _errs66){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing7;
if((((data.kind === undefined) && (missing7 = "kind")) || ((data.messages === undefined) && (missing7 = "messages"))) || ((data.turnLimitReached === undefined) && (missing7 = "turnLimitReached"))){
const err56 = {instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing7},message:"must have required property '"+missing7+"'"};
if(vErrors === null){
vErrors = [err56];
}
else {
vErrors.push(err56);
}
errors++;
}
else {
const _errs68 = errors;
for(const key7 in data){
if(!(((key7 === "kind") || (key7 === "messages")) || (key7 === "turnLimitReached"))){
const err57 = {instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err57];
}
else {
vErrors.push(err57);
}
errors++;
break;
}
}
if(_errs68 === errors){
if(data.kind !== undefined){
let data23 = data.kind;
const _errs69 = errors;
if(typeof data23 !== "string"){
const err58 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err58];
}
else {
vErrors.push(err58);
}
errors++;
}
if("result" !== data23){
const err59 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "result"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err59];
}
else {
vErrors.push(err59);
}
errors++;
}
var valid12 = _errs69 === errors;
}
else {
var valid12 = true;
}
if(valid12){
if(data.turnLimitReached !== undefined){
const _errs71 = errors;
if(typeof data.turnLimitReached !== "boolean"){
const err60 = {instancePath:instancePath+"/turnLimitReached",schemaPath:"#/oneOf/6/properties/turnLimitReached/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err60];
}
else {
vErrors.push(err60);
}
errors++;
}
var valid12 = _errs71 === errors;
}
else {
var valid12 = true;
}
}
}
}
}
else {
const err61 = {instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err61];
}
else {
vErrors.push(err61);
}
errors++;
}
}
var _valid0 = _errs66 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 6];
}
else {
if(_valid0){
valid0 = true;
passing0 = 6;
if(props0 !== true){
props0 = true;
}
}
const _errs73 = errors;
if(errors === _errs73){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing8;
if((data.kind === undefined) && (missing8 = "kind")){
const err62 = {instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing8},message:"must have required property '"+missing8+"'"};
if(vErrors === null){
vErrors = [err62];
}
else {
vErrors.push(err62);
}
errors++;
}
else {
const _errs75 = errors;
for(const key8 in data){
if(!(key8 === "kind")){
const err63 = {instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err63];
}
else {
vErrors.push(err63);
}
errors++;
break;
}
}
if(_errs75 === errors){
if(data.kind !== undefined){
let data25 = data.kind;
if(typeof data25 !== "string"){
const err64 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err64];
}
else {
vErrors.push(err64);
}
errors++;
}
if("closed" !== data25){
const err65 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/const",keyword:"const",params:{allowedValue: "closed"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err65];
}
else {
vErrors.push(err65);
}
errors++;
}
}
}
}
}
else {
const err66 = {instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err66];
}
else {
vErrors.push(err66);
}
errors++;
}
}
var _valid0 = _errs73 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 7];
}
else {
if(_valid0){
valid0 = true;
passing0 = 7;
if(props0 !== true){
props0 = true;
}
}
const _errs78 = errors;
if(errors === _errs78){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing9;
if(((data.kind === undefined) && (missing9 = "kind")) || ((data.code === undefined) && (missing9 = "code"))){
const err67 = {instancePath,schemaPath:"#/oneOf/8/required",keyword:"required",params:{missingProperty: missing9},message:"must have required property '"+missing9+"'"};
if(vErrors === null){
vErrors = [err67];
}
else {
vErrors.push(err67);
}
errors++;
}
else {
const _errs80 = errors;
for(const key9 in data){
if(!((key9 === "code") || (key9 === "kind"))){
const err68 = {instancePath,schemaPath:"#/oneOf/8/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err68];
}
else {
vErrors.push(err68);
}
errors++;
break;
}
}
if(_errs80 === errors){
if(data.code !== undefined){
const _errs81 = errors;
if(typeof data.code !== "string"){
const err69 = {instancePath:instancePath+"/code",schemaPath:"#/oneOf/8/properties/code/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err69];
}
else {
vErrors.push(err69);
}
errors++;
}
var valid14 = _errs81 === errors;
}
else {
var valid14 = true;
}
if(valid14){
if(data.kind !== undefined){
let data27 = data.kind;
const _errs83 = errors;
if(typeof data27 !== "string"){
const err70 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/8/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err70];
}
else {
vErrors.push(err70);
}
errors++;
}
if("fault" !== data27){
const err71 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/8/properties/kind/const",keyword:"const",params:{allowedValue: "fault"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err71];
}
else {
vErrors.push(err71);
}
errors++;
}
var valid14 = _errs83 === errors;
}
else {
var valid14 = true;
}
}
}
}
}
else {
const err72 = {instancePath,schemaPath:"#/oneOf/8/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err72];
}
else {
vErrors.push(err72);
}
errors++;
}
}
var _valid0 = _errs78 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 8];
}
else {
if(_valid0){
valid0 = true;
passing0 = 8;
if(props0 !== true){
props0 = true;
}
}
}
}
}
}
}
}
}
}
if(!valid0){
const err73 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err73];
}
else {
vErrors.push(err73);
}
errors++;
validate21.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate21.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate21.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate20(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate20.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.protocolVersion === undefined) && (missing0 = "protocolVersion")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.sequence === undefined) && (missing0 = "sequence"))) || ((data.body === undefined) && (missing0 = "body"))){
validate20.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "body") || (key0 === "protocolVersion")) || (key0 === "sequence")) || (key0 === "sessionId"))){
validate20.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.body !== undefined){
const _errs2 = errors;
if(!(validate21(data.body, {instancePath:instancePath+"/body",parentData:data,parentDataProperty:"body",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate21.errors : vErrors.concat(validate21.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.protocolVersion !== undefined){
let data1 = data.protocolVersion;
const _errs3 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate20.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/properties/protocolVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs3){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4 || isNaN(data1)){
validate20.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/properties/protocolVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4},message:"must be <= 4"}];
return false;
}
else {
if(data1 < 4 || isNaN(data1)){
validate20.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/properties/protocolVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 4},message:"must be >= 4"}];
return false;
}
}
}
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sequence !== undefined){
let data2 = data.sequence;
const _errs5 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate20.errors = [{instancePath:instancePath+"/sequence",schemaPath:"#/properties/sequence/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate20.errors = [{instancePath:instancePath+"/sequence",schemaPath:"#/properties/sequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate20.errors = [{instancePath:instancePath+"/sequence",schemaPath:"#/properties/sequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sessionId !== undefined){
let data3 = data.sessionId;
const _errs7 = errors;
const _errs8 = errors;
if(errors === _errs8){
if(typeof data3 === "string"){
if(!pattern4.test(data3)){
validate20.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/ExecutionId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},message:"must match pattern \""+"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"+"\""}];
return false;
}
}
else {
validate20.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"#/$defs/ExecutionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
else {
validate20.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate20.errors = vErrors;
return errors === 0;
}
validate20.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
