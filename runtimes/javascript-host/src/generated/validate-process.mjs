// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.
"use strict";
export const validate = validate20;
export default validate20;
const schema31 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ProcessFrame","description":"Wire representation: a four-byte big-endian length followed by exactly that\nmany JSON bytes. Stdout is reserved for frames; stderr is a separate bounded\ndiagnostic stream. Hosts must also enforce direction, state and deadlines.","type":"object","properties":{"body":{"$ref":"#/$defs/ProcessBody"},"protocolVersion":{"type":"integer","const":2}},"additionalProperties":false,"required":["protocolVersion","body"],"$defs":{"CapabilityDeclaration":{"type":"object","properties":{"contract":{"$ref":"#/$defs/ContractRef"},"effect":{"$ref":"#/$defs/EffectKind"},"errorSchema":{"$ref":"#/$defs/ContractRef"},"inputSchema":{"$ref":"#/$defs/ContractRef"},"limits":{"$ref":"#/$defs/CapabilityLimits"},"outputSchema":{"$ref":"#/$defs/ContractRef"},"permissions":{"type":"array","items":{"$ref":"#/$defs/PermissionRequest"}},"profiles":{"type":"array","items":{"$ref":"#/$defs/ContractRef"}}},"additionalProperties":false,"required":["contract","inputSchema","outputSchema","errorSchema","profiles","effect","permissions","limits"]},"CapabilityLimits":{"description":"Requested upper bounds. The host must also enforce its own current limits.","type":"object","properties":{"concurrency":{"type":"integer","maximum":65535,"minimum":1},"maxInputBytes":{"type":"integer","maximum":4294967295,"minimum":1},"maxOutputBytes":{"type":"integer","maximum":4294967295,"minimum":1},"timeoutMs":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["maxInputBytes","maxOutputBytes","concurrency","timeoutMs"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"EffectKind":{"description":"Read-only concerns project state; proposals are not already-adopted changes.\nNetwork/process effects still require their own host authorization.","type":"string","enum":["read-only","proposal","external"]},"EncodedPayload":{"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]},"InvocationContext":{"type":"object","properties":{"attemptId":{"type":"string"},"configurationDigest":{"type":"string"},"dispatchId":{"type":"string"},"environmentDigest":{"type":"string"},"inputDigest":{"type":"string"},"itemId":{"type":"string"},"operationId":{"type":"string"},"projectId":{"type":"string"},"scopeDigest":{"type":"string"},"scopeId":{"type":"string"}},"additionalProperties":false,"required":["projectId","operationId","attemptId","itemId","dispatchId","scopeId","inputDigest","scopeDigest","environmentDigest","configurationDigest"]},"InvocationOutcome":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"succeeded"},"output":{"$ref":"#/$defs/EncodedPayload"}},"additionalProperties":false,"required":["kind","output"]},{"type":"object","properties":{"error":{"$ref":"#/$defs/EncodedPayload"},"kind":{"type":"string","const":"failed"}},"additionalProperties":false,"required":["kind","error"]},{"type":"object","properties":{"error":{"$ref":"#/$defs/EncodedPayload"},"kind":{"type":"string","const":"unknown"}},"additionalProperties":false,"required":["kind","error"]}]},"InvocationRequest":{"type":"object","properties":{"capability":{"$ref":"#/$defs/ContractRef"},"context":{"$ref":"#/$defs/InvocationContext"},"errorSchema":{"$ref":"#/$defs/ContractRef"},"input":{"$ref":"#/$defs/EncodedPayload"},"maxResultBytes":{"type":"integer","maximum":4294967295,"minimum":1},"outputSchema":{"$ref":"#/$defs/ContractRef"},"profile":{"anyOf":[{"$ref":"#/$defs/ContractRef"},{"type":"null"}]},"provider":{"$ref":"#/$defs/ProviderBinding"}},"additionalProperties":false,"required":["context","provider","capability","input","outputSchema","errorSchema","maxResultBytes"]},"InvocationResult":{"type":"object","properties":{"capability":{"$ref":"#/$defs/ContractRef"},"context":{"$ref":"#/$defs/InvocationContext"},"outcome":{"$ref":"#/$defs/InvocationOutcome"},"profile":{"anyOf":[{"$ref":"#/$defs/ContractRef"},{"type":"null"}]},"provider":{"$ref":"#/$defs/ProviderBinding"},"resultId":{"type":"string"}},"additionalProperties":false,"required":["context","provider","capability","resultId","outcome"]},"PermissionRequest":{"description":"These are requested permissions, never an authorization token.","oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"captured-input"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"staged-output"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"contract":{"$ref":"#/$defs/ContractRef"},"kind":{"type":"string","const":"project-service"}},"additionalProperties":false,"required":["kind","contract"]},{"type":"object","properties":{"destination":{"type":"string"},"kind":{"type":"string","const":"network"}},"additionalProperties":false,"required":["kind","destination"]},{"type":"object","properties":{"kind":{"type":"string","const":"process"},"program":{"type":"string"}},"additionalProperties":false,"required":["kind","program"]}]},"PluginIdentity":{"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]},"ProcessActivation":{"description":"A captured declaration for one capability on one actual component channel.\nEchoing this structure is a handshake claim, never a grant or source proof.","type":"object","properties":{"capability":{"$ref":"#/$defs/CapabilityDeclaration"},"provider":{"$ref":"#/$defs/ProviderBinding"},"services":{"description":"Host-selected project services, resolved before component activation.","type":"array","items":{"$ref":"#/$defs/ServiceBinding"}}},"additionalProperties":false,"required":["provider","capability","services"]},"ProcessBody":{"oneOf":[{"type":"object","properties":{"data":{"$ref":"#/$defs/ProcessActivation"},"kind":{"type":"string","const":"activate"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/ProcessActivation"},"kind":{"type":"string","const":"ready"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/InvocationRequest"},"kind":{"type":"string","const":"invoke"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/InvocationResult"},"kind":{"type":"string","const":"result"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/ServiceRequest"},"kind":{"type":"string","const":"service-request"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/ServiceResponse"},"kind":{"type":"string","const":"service-response"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"dispatchId":{"type":"string"}},"additionalProperties":false,"required":["dispatchId"]},"kind":{"type":"string","const":"cancel"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"dispatchId":{"type":"string"}},"additionalProperties":false,"required":["dispatchId"]},"kind":{"type":"string","const":"cancelled"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"provider":{"$ref":"#/$defs/ProviderBinding"}},"additionalProperties":false,"required":["provider"]},"kind":{"type":"string","const":"close"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"provider":{"$ref":"#/$defs/ProviderBinding"}},"additionalProperties":false,"required":["provider"]},"kind":{"type":"string","const":"closed"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"nonce":{"type":"string"}},"additionalProperties":false,"required":["nonce"]},"kind":{"type":"string","const":"ping"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"nonce":{"type":"string"}},"additionalProperties":false,"required":["nonce"]},"kind":{"type":"string","const":"pong"}},"additionalProperties":false,"required":["kind","data"]}]},"ProviderBinding":{"description":"A claimed wire binding. Only the trusted host can compare it to the actual\nverified package and channel; constructing this value proves no authority.","type":"object","properties":{"activationGeneration":{"type":"integer","maximum":4294967295,"minimum":1},"componentId":{"type":"string"},"contributionId":{"type":"string"},"instanceId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest","instanceId","activationGeneration"]},"ServiceBinding":{"description":"A Host-selected service descriptor, not a grant or a project/store handle.\nThe Host authenticates its provider, scope, configuration and live generation.","type":"object","properties":{"activationGeneration":{"type":"integer","maximum":4294967295,"minimum":1},"configurationDigest":{"type":"string"},"contract":{"$ref":"#/$defs/ContractRef"},"effect":{"$ref":"#/$defs/EffectKind"},"errorSchema":{"$ref":"#/$defs/ContractRef"},"handleId":{"type":"string"},"inputSchema":{"$ref":"#/$defs/ContractRef"},"limits":{"$ref":"#/$defs/CapabilityLimits"},"outputSchema":{"$ref":"#/$defs/ContractRef"},"projectId":{"type":"string"},"providerId":{"type":"string"},"scopeId":{"type":"string"}},"additionalProperties":false,"required":["handleId","providerId","contract","inputSchema","outputSchema","errorSchema","effect","projectId","scopeId","activationGeneration","configurationDigest","limits"]},"ServiceRequest":{"description":"The context is the original outer invocation. Its inputDigest describes that\ninvocation, while input.sha256 independently authenticates the service bytes.","type":"object","properties":{"callId":{"type":"string"},"context":{"$ref":"#/$defs/InvocationContext"},"handleId":{"type":"string"},"input":{"$ref":"#/$defs/EncodedPayload"}},"additionalProperties":false,"required":["callId","handleId","context","input"]},"ServiceResponse":{"description":"A response preserves failed/unknown outcomes. Matching it does not authorize\na mutation, validate its domain payload or prove that a child task finished.","type":"object","properties":{"callId":{"type":"string"},"context":{"$ref":"#/$defs/InvocationContext"},"handleId":{"type":"string"},"outcome":{"$ref":"#/$defs/InvocationOutcome"}},"additionalProperties":false,"required":["callId","handleId","context","outcome"]}}};
const schema32 = {"oneOf":[{"type":"object","properties":{"data":{"$ref":"#/$defs/ProcessActivation"},"kind":{"type":"string","const":"activate"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/ProcessActivation"},"kind":{"type":"string","const":"ready"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/InvocationRequest"},"kind":{"type":"string","const":"invoke"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/InvocationResult"},"kind":{"type":"string","const":"result"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/ServiceRequest"},"kind":{"type":"string","const":"service-request"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"$ref":"#/$defs/ServiceResponse"},"kind":{"type":"string","const":"service-response"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"dispatchId":{"type":"string"}},"additionalProperties":false,"required":["dispatchId"]},"kind":{"type":"string","const":"cancel"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"dispatchId":{"type":"string"}},"additionalProperties":false,"required":["dispatchId"]},"kind":{"type":"string","const":"cancelled"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"provider":{"$ref":"#/$defs/ProviderBinding"}},"additionalProperties":false,"required":["provider"]},"kind":{"type":"string","const":"close"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"provider":{"$ref":"#/$defs/ProviderBinding"}},"additionalProperties":false,"required":["provider"]},"kind":{"type":"string","const":"closed"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"nonce":{"type":"string"}},"additionalProperties":false,"required":["nonce"]},"kind":{"type":"string","const":"ping"}},"additionalProperties":false,"required":["kind","data"]},{"type":"object","properties":{"data":{"type":"object","properties":{"nonce":{"type":"string"}},"additionalProperties":false,"required":["nonce"]},"kind":{"type":"string","const":"pong"}},"additionalProperties":false,"required":["kind","data"]}]};
const schema33 = {"description":"A captured declaration for one capability on one actual component channel.\nEchoing this structure is a handshake claim, never a grant or source proof.","type":"object","properties":{"capability":{"$ref":"#/$defs/CapabilityDeclaration"},"provider":{"$ref":"#/$defs/ProviderBinding"},"services":{"description":"Host-selected project services, resolved before component activation.","type":"array","items":{"$ref":"#/$defs/ServiceBinding"}}},"additionalProperties":false,"required":["provider","capability","services"]};
const schema34 = {"type":"object","properties":{"contract":{"$ref":"#/$defs/ContractRef"},"effect":{"$ref":"#/$defs/EffectKind"},"errorSchema":{"$ref":"#/$defs/ContractRef"},"inputSchema":{"$ref":"#/$defs/ContractRef"},"limits":{"$ref":"#/$defs/CapabilityLimits"},"outputSchema":{"$ref":"#/$defs/ContractRef"},"permissions":{"type":"array","items":{"$ref":"#/$defs/PermissionRequest"}},"profiles":{"type":"array","items":{"$ref":"#/$defs/ContractRef"}}},"additionalProperties":false,"required":["contract","inputSchema","outputSchema","errorSchema","profiles","effect","permissions","limits"]};
const schema35 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema36 = {"description":"Read-only concerns project state; proposals are not already-adopted changes.\nNetwork/process effects still require their own host authorization.","type":"string","enum":["read-only","proposal","external"]};
const schema39 = {"description":"Requested upper bounds. The host must also enforce its own current limits.","type":"object","properties":{"concurrency":{"type":"integer","maximum":65535,"minimum":1},"maxInputBytes":{"type":"integer","maximum":4294967295,"minimum":1},"maxOutputBytes":{"type":"integer","maximum":4294967295,"minimum":1},"timeoutMs":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["maxInputBytes","maxOutputBytes","concurrency","timeoutMs"]};
const schema41 = {"description":"These are requested permissions, never an authorization token.","oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"captured-input"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"staged-output"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"contract":{"$ref":"#/$defs/ContractRef"},"kind":{"type":"string","const":"project-service"}},"additionalProperties":false,"required":["kind","contract"]},{"type":"object","properties":{"destination":{"type":"string"},"kind":{"type":"string","const":"network"}},"additionalProperties":false,"required":["kind","destination"]},{"type":"object","properties":{"kind":{"type":"string","const":"process"},"program":{"type":"string"}},"additionalProperties":false,"required":["kind","program"]}]};

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
if((data.kind === undefined) && (missing0 = "kind")){
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
if(!(key0 === "kind")){
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
if("captured-input" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "captured-input"},message:"must be equal to constant"};
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
if((data.kind === undefined) && (missing1 = "kind")){
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
if(!(key1 === "kind")){
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
if(data.kind !== undefined){
let data1 = data.kind;
if(typeof data1 !== "string"){
const err7 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if("staged-output" !== data1){
const err8 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "staged-output"},message:"must be equal to constant"};
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
}
else {
const err9 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
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
const _errs11 = errors;
if(errors === _errs11){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if(((data.kind === undefined) && (missing2 = "kind")) || ((data.contract === undefined) && (missing2 = "contract"))){
const err10 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
else {
const _errs13 = errors;
for(const key2 in data){
if(!((key2 === "contract") || (key2 === "kind"))){
const err11 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
break;
}
}
if(_errs13 === errors){
if(data.contract !== undefined){
let data2 = data.contract;
const _errs14 = errors;
const _errs15 = errors;
if(errors === _errs15){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing3;
if((((data2.id === undefined) && (missing3 = "id")) || ((data2.schemaVersion === undefined) && (missing3 = "schemaVersion"))) || ((data2.behaviorVersion === undefined) && (missing3 = "behaviorVersion"))){
const err12 = {instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
else {
const _errs17 = errors;
for(const key3 in data2){
if(!(((key3 === "behaviorVersion") || (key3 === "id")) || (key3 === "schemaVersion"))){
const err13 = {instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
break;
}
}
if(_errs17 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs18 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
const err14 = {instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
if(errors === _errs18){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
const err15 = {instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
if(data3 < 1 || isNaN(data3)){
const err16 = {instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
}
}
}
var valid5 = _errs18 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data2.id !== undefined){
const _errs20 = errors;
if(typeof data2.id !== "string"){
const err17 = {instancePath:instancePath+"/contract/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
var valid5 = _errs20 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data2.schemaVersion !== undefined){
let data5 = data2.schemaVersion;
const _errs22 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
const err18 = {instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
if(errors === _errs22){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
const err19 = {instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
else {
if(data5 < 1 || isNaN(data5)){
const err20 = {instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
}
}
var valid5 = _errs22 === errors;
}
else {
var valid5 = true;
}
}
}
}
}
}
else {
const err21 = {instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data.kind !== undefined){
let data6 = data.kind;
const _errs24 = errors;
if(typeof data6 !== "string"){
const err22 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
if("project-service" !== data6){
const err23 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "project-service"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
var valid3 = _errs24 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
const err24 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
}
var _valid0 = _errs11 === errors;
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
const _errs26 = errors;
if(errors === _errs26){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if(((data.kind === undefined) && (missing4 = "kind")) || ((data.destination === undefined) && (missing4 = "destination"))){
const err25 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
else {
const _errs28 = errors;
for(const key4 in data){
if(!((key4 === "destination") || (key4 === "kind"))){
const err26 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
break;
}
}
if(_errs28 === errors){
if(data.destination !== undefined){
const _errs29 = errors;
if(typeof data.destination !== "string"){
const err27 = {instancePath:instancePath+"/destination",schemaPath:"#/oneOf/3/properties/destination/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
var valid6 = _errs29 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.kind !== undefined){
let data8 = data.kind;
const _errs31 = errors;
if(typeof data8 !== "string"){
const err28 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
if("network" !== data8){
const err29 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "network"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
var valid6 = _errs31 === errors;
}
else {
var valid6 = true;
}
}
}
}
}
else {
const err30 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
}
var _valid0 = _errs26 === errors;
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
const _errs33 = errors;
if(errors === _errs33){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if(((data.kind === undefined) && (missing5 = "kind")) || ((data.program === undefined) && (missing5 = "program"))){
const err31 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
}
else {
const _errs35 = errors;
for(const key5 in data){
if(!((key5 === "kind") || (key5 === "program"))){
const err32 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
break;
}
}
if(_errs35 === errors){
if(data.kind !== undefined){
let data9 = data.kind;
const _errs36 = errors;
if(typeof data9 !== "string"){
const err33 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err33];
}
else {
vErrors.push(err33);
}
errors++;
}
if("process" !== data9){
const err34 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "process"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
var valid7 = _errs36 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data.program !== undefined){
const _errs38 = errors;
if(typeof data.program !== "string"){
const err35 = {instancePath:instancePath+"/program",schemaPath:"#/oneOf/4/properties/program/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
var valid7 = _errs38 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
else {
const err36 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
}
var _valid0 = _errs33 === errors;
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
}
}
}
}
if(!valid0){
const err37 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
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


function validate23(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate23.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((((data.contract === undefined) && (missing0 = "contract")) || ((data.inputSchema === undefined) && (missing0 = "inputSchema"))) || ((data.outputSchema === undefined) && (missing0 = "outputSchema"))) || ((data.errorSchema === undefined) && (missing0 = "errorSchema"))) || ((data.profiles === undefined) && (missing0 = "profiles"))) || ((data.effect === undefined) && (missing0 = "effect"))) || ((data.permissions === undefined) && (missing0 = "permissions"))) || ((data.limits === undefined) && (missing0 = "limits"))){
validate23.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "contract") || (key0 === "effect")) || (key0 === "errorSchema")) || (key0 === "inputSchema")) || (key0 === "limits")) || (key0 === "outputSchema")) || (key0 === "permissions")) || (key0 === "profiles"))){
validate23.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.contract !== undefined){
let data0 = data.contract;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate23.errors = [{instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate23.errors = [{instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate23.errors = [{instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate23.errors = [{instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate23.errors = [{instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.id !== undefined){
const _errs8 = errors;
if(typeof data0.id !== "string"){
validate23.errors = [{instancePath:instancePath+"/contract/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.schemaVersion !== undefined){
let data3 = data0.schemaVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate23.errors = [{instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate23.errors = [{instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate23.errors = [{instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.effect !== undefined){
let data4 = data.effect;
const _errs12 = errors;
if(typeof data4 !== "string"){
validate23.errors = [{instancePath:instancePath+"/effect",schemaPath:"#/$defs/EffectKind/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data4 === "read-only") || (data4 === "proposal")) || (data4 === "external"))){
validate23.errors = [{instancePath:instancePath+"/effect",schemaPath:"#/$defs/EffectKind/enum",keyword:"enum",params:{allowedValues: schema36.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.errorSchema !== undefined){
let data5 = data.errorSchema;
const _errs15 = errors;
const _errs16 = errors;
if(errors === _errs16){
if(data5 && typeof data5 == "object" && !Array.isArray(data5)){
let missing2;
if((((data5.id === undefined) && (missing2 = "id")) || ((data5.schemaVersion === undefined) && (missing2 = "schemaVersion"))) || ((data5.behaviorVersion === undefined) && (missing2 = "behaviorVersion"))){
validate23.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs18 = errors;
for(const key2 in data5){
if(!(((key2 === "behaviorVersion") || (key2 === "id")) || (key2 === "schemaVersion"))){
validate23.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs18 === errors){
if(data5.behaviorVersion !== undefined){
let data6 = data5.behaviorVersion;
const _errs19 = errors;
if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){
validate23.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs19){
if((typeof data6 == "number") && (isFinite(data6))){
if(data6 > 4294967295 || isNaN(data6)){
validate23.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data6 < 1 || isNaN(data6)){
validate23.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid5 = _errs19 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data5.id !== undefined){
const _errs21 = errors;
if(typeof data5.id !== "string"){
validate23.errors = [{instancePath:instancePath+"/errorSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid5 = _errs21 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data5.schemaVersion !== undefined){
let data8 = data5.schemaVersion;
const _errs23 = errors;
if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){
validate23.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs23){
if((typeof data8 == "number") && (isFinite(data8))){
if(data8 > 4294967295 || isNaN(data8)){
validate23.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data8 < 1 || isNaN(data8)){
validate23.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid5 = _errs23 === errors;
}
else {
var valid5 = true;
}
}
}
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.inputSchema !== undefined){
let data9 = data.inputSchema;
const _errs25 = errors;
const _errs26 = errors;
if(errors === _errs26){
if(data9 && typeof data9 == "object" && !Array.isArray(data9)){
let missing3;
if((((data9.id === undefined) && (missing3 = "id")) || ((data9.schemaVersion === undefined) && (missing3 = "schemaVersion"))) || ((data9.behaviorVersion === undefined) && (missing3 = "behaviorVersion"))){
validate23.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"}];
return false;
}
else {
const _errs28 = errors;
for(const key3 in data9){
if(!(((key3 === "behaviorVersion") || (key3 === "id")) || (key3 === "schemaVersion"))){
validate23.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs28 === errors){
if(data9.behaviorVersion !== undefined){
let data10 = data9.behaviorVersion;
const _errs29 = errors;
if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){
validate23.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs29){
if((typeof data10 == "number") && (isFinite(data10))){
if(data10 > 4294967295 || isNaN(data10)){
validate23.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data10 < 1 || isNaN(data10)){
validate23.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid7 = _errs29 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data9.id !== undefined){
const _errs31 = errors;
if(typeof data9.id !== "string"){
validate23.errors = [{instancePath:instancePath+"/inputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs31 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data9.schemaVersion !== undefined){
let data12 = data9.schemaVersion;
const _errs33 = errors;
if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){
validate23.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs33){
if((typeof data12 == "number") && (isFinite(data12))){
if(data12 > 4294967295 || isNaN(data12)){
validate23.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data12 < 1 || isNaN(data12)){
validate23.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid7 = _errs33 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs25 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.limits !== undefined){
let data13 = data.limits;
const _errs35 = errors;
const _errs36 = errors;
if(errors === _errs36){
if(data13 && typeof data13 == "object" && !Array.isArray(data13)){
let missing4;
if(((((data13.maxInputBytes === undefined) && (missing4 = "maxInputBytes")) || ((data13.maxOutputBytes === undefined) && (missing4 = "maxOutputBytes"))) || ((data13.concurrency === undefined) && (missing4 = "concurrency"))) || ((data13.timeoutMs === undefined) && (missing4 = "timeoutMs"))){
validate23.errors = [{instancePath:instancePath+"/limits",schemaPath:"#/$defs/CapabilityLimits/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"}];
return false;
}
else {
const _errs38 = errors;
for(const key4 in data13){
if(!((((key4 === "concurrency") || (key4 === "maxInputBytes")) || (key4 === "maxOutputBytes")) || (key4 === "timeoutMs"))){
validate23.errors = [{instancePath:instancePath+"/limits",schemaPath:"#/$defs/CapabilityLimits/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs38 === errors){
if(data13.concurrency !== undefined){
let data14 = data13.concurrency;
const _errs39 = errors;
if(!(((typeof data14 == "number") && (!(data14 % 1) && !isNaN(data14))) && (isFinite(data14)))){
validate23.errors = [{instancePath:instancePath+"/limits/concurrency",schemaPath:"#/$defs/CapabilityLimits/properties/concurrency/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs39){
if((typeof data14 == "number") && (isFinite(data14))){
if(data14 > 65535 || isNaN(data14)){
validate23.errors = [{instancePath:instancePath+"/limits/concurrency",schemaPath:"#/$defs/CapabilityLimits/properties/concurrency/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535},message:"must be <= 65535"}];
return false;
}
else {
if(data14 < 1 || isNaN(data14)){
validate23.errors = [{instancePath:instancePath+"/limits/concurrency",schemaPath:"#/$defs/CapabilityLimits/properties/concurrency/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs39 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data13.maxInputBytes !== undefined){
let data15 = data13.maxInputBytes;
const _errs41 = errors;
if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){
validate23.errors = [{instancePath:instancePath+"/limits/maxInputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxInputBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs41){
if((typeof data15 == "number") && (isFinite(data15))){
if(data15 > 4294967295 || isNaN(data15)){
validate23.errors = [{instancePath:instancePath+"/limits/maxInputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxInputBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data15 < 1 || isNaN(data15)){
validate23.errors = [{instancePath:instancePath+"/limits/maxInputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxInputBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs41 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data13.maxOutputBytes !== undefined){
let data16 = data13.maxOutputBytes;
const _errs43 = errors;
if(!(((typeof data16 == "number") && (!(data16 % 1) && !isNaN(data16))) && (isFinite(data16)))){
validate23.errors = [{instancePath:instancePath+"/limits/maxOutputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxOutputBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs43){
if((typeof data16 == "number") && (isFinite(data16))){
if(data16 > 4294967295 || isNaN(data16)){
validate23.errors = [{instancePath:instancePath+"/limits/maxOutputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxOutputBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data16 < 1 || isNaN(data16)){
validate23.errors = [{instancePath:instancePath+"/limits/maxOutputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxOutputBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs43 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data13.timeoutMs !== undefined){
let data17 = data13.timeoutMs;
const _errs45 = errors;
if(!(((typeof data17 == "number") && (!(data17 % 1) && !isNaN(data17))) && (isFinite(data17)))){
validate23.errors = [{instancePath:instancePath+"/limits/timeoutMs",schemaPath:"#/$defs/CapabilityLimits/properties/timeoutMs/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs45){
if((typeof data17 == "number") && (isFinite(data17))){
if(data17 > 4294967295 || isNaN(data17)){
validate23.errors = [{instancePath:instancePath+"/limits/timeoutMs",schemaPath:"#/$defs/CapabilityLimits/properties/timeoutMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data17 < 1 || isNaN(data17)){
validate23.errors = [{instancePath:instancePath+"/limits/timeoutMs",schemaPath:"#/$defs/CapabilityLimits/properties/timeoutMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs45 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/limits",schemaPath:"#/$defs/CapabilityLimits/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs35 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outputSchema !== undefined){
let data18 = data.outputSchema;
const _errs47 = errors;
const _errs48 = errors;
if(errors === _errs48){
if(data18 && typeof data18 == "object" && !Array.isArray(data18)){
let missing5;
if((((data18.id === undefined) && (missing5 = "id")) || ((data18.schemaVersion === undefined) && (missing5 = "schemaVersion"))) || ((data18.behaviorVersion === undefined) && (missing5 = "behaviorVersion"))){
validate23.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"}];
return false;
}
else {
const _errs50 = errors;
for(const key5 in data18){
if(!(((key5 === "behaviorVersion") || (key5 === "id")) || (key5 === "schemaVersion"))){
validate23.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs50 === errors){
if(data18.behaviorVersion !== undefined){
let data19 = data18.behaviorVersion;
const _errs51 = errors;
if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){
validate23.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs51){
if((typeof data19 == "number") && (isFinite(data19))){
if(data19 > 4294967295 || isNaN(data19)){
validate23.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data19 < 1 || isNaN(data19)){
validate23.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid11 = _errs51 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data18.id !== undefined){
const _errs53 = errors;
if(typeof data18.id !== "string"){
validate23.errors = [{instancePath:instancePath+"/outputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid11 = _errs53 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data18.schemaVersion !== undefined){
let data21 = data18.schemaVersion;
const _errs55 = errors;
if(!(((typeof data21 == "number") && (!(data21 % 1) && !isNaN(data21))) && (isFinite(data21)))){
validate23.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs55){
if((typeof data21 == "number") && (isFinite(data21))){
if(data21 > 4294967295 || isNaN(data21)){
validate23.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data21 < 1 || isNaN(data21)){
validate23.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid11 = _errs55 === errors;
}
else {
var valid11 = true;
}
}
}
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs47 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.permissions !== undefined){
let data22 = data.permissions;
const _errs57 = errors;
if(errors === _errs57){
if(Array.isArray(data22)){
var valid12 = true;
const len0 = data22.length;
for(let i0=0; i0<len0; i0++){
const _errs59 = errors;
if(!(validate24(data22[i0], {instancePath:instancePath+"/permissions/" + i0,parentData:data22,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate24.errors : vErrors.concat(validate24.errors);
errors = vErrors.length;
}
var valid12 = _errs59 === errors;
if(!valid12){
break;
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/permissions",schemaPath:"#/properties/permissions/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs57 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profiles !== undefined){
let data24 = data.profiles;
const _errs60 = errors;
if(errors === _errs60){
if(Array.isArray(data24)){
var valid13 = true;
const len1 = data24.length;
for(let i1=0; i1<len1; i1++){
let data25 = data24[i1];
const _errs62 = errors;
const _errs63 = errors;
if(errors === _errs63){
if(data25 && typeof data25 == "object" && !Array.isArray(data25)){
let missing6;
if((((data25.id === undefined) && (missing6 = "id")) || ((data25.schemaVersion === undefined) && (missing6 = "schemaVersion"))) || ((data25.behaviorVersion === undefined) && (missing6 = "behaviorVersion"))){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1,schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing6},message:"must have required property '"+missing6+"'"}];
return false;
}
else {
const _errs65 = errors;
for(const key6 in data25){
if(!(((key6 === "behaviorVersion") || (key6 === "id")) || (key6 === "schemaVersion"))){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1,schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs65 === errors){
if(data25.behaviorVersion !== undefined){
let data26 = data25.behaviorVersion;
const _errs66 = errors;
if(!(((typeof data26 == "number") && (!(data26 % 1) && !isNaN(data26))) && (isFinite(data26)))){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs66){
if((typeof data26 == "number") && (isFinite(data26))){
if(data26 > 4294967295 || isNaN(data26)){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data26 < 1 || isNaN(data26)){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid15 = _errs66 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data25.id !== undefined){
const _errs68 = errors;
if(typeof data25.id !== "string"){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid15 = _errs68 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data25.schemaVersion !== undefined){
let data28 = data25.schemaVersion;
const _errs70 = errors;
if(!(((typeof data28 == "number") && (!(data28 % 1) && !isNaN(data28))) && (isFinite(data28)))){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs70){
if((typeof data28 == "number") && (isFinite(data28))){
if(data28 > 4294967295 || isNaN(data28)){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data28 < 1 || isNaN(data28)){
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1+"/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid15 = _errs70 === errors;
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
validate23.errors = [{instancePath:instancePath+"/profiles/" + i1,schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid13 = _errs62 === errors;
if(!valid13){
break;
}
}
}
else {
validate23.errors = [{instancePath:instancePath+"/profiles",schemaPath:"#/properties/profiles/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs60 === errors;
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
}
}
}
else {
validate23.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate23.errors = vErrors;
return errors === 0;
}
validate23.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema44 = {"description":"A claimed wire binding. Only the trusted host can compare it to the actual\nverified package and channel; constructing this value proves no authority.","type":"object","properties":{"activationGeneration":{"type":"integer","maximum":4294967295,"minimum":1},"componentId":{"type":"string"},"contributionId":{"type":"string"},"instanceId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest","instanceId","activationGeneration"]};
const schema45 = {"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]};

function validate27(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate27.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((data.plugin === undefined) && (missing0 = "plugin")) || ((data.componentId === undefined) && (missing0 = "componentId"))) || ((data.contributionId === undefined) && (missing0 = "contributionId"))) || ((data.packageDigest === undefined) && (missing0 = "packageDigest"))) || ((data.instanceId === undefined) && (missing0 = "instanceId"))) || ((data.activationGeneration === undefined) && (missing0 = "activationGeneration"))){
validate27.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((key0 === "activationGeneration") || (key0 === "componentId")) || (key0 === "contributionId")) || (key0 === "instanceId")) || (key0 === "packageDigest")) || (key0 === "plugin"))){
validate27.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.activationGeneration !== undefined){
let data0 = data.activationGeneration;
const _errs2 = errors;
if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){
validate27.errors = [{instancePath:instancePath+"/activationGeneration",schemaPath:"#/properties/activationGeneration/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs2){
if((typeof data0 == "number") && (isFinite(data0))){
if(data0 > 4294967295 || isNaN(data0)){
validate27.errors = [{instancePath:instancePath+"/activationGeneration",schemaPath:"#/properties/activationGeneration/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data0 < 1 || isNaN(data0)){
validate27.errors = [{instancePath:instancePath+"/activationGeneration",schemaPath:"#/properties/activationGeneration/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
if(data.componentId !== undefined){
const _errs4 = errors;
if(typeof data.componentId !== "string"){
validate27.errors = [{instancePath:instancePath+"/componentId",schemaPath:"#/properties/componentId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.contributionId !== undefined){
const _errs6 = errors;
if(typeof data.contributionId !== "string"){
validate27.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.instanceId !== undefined){
const _errs8 = errors;
if(typeof data.instanceId !== "string"){
validate27.errors = [{instancePath:instancePath+"/instanceId",schemaPath:"#/properties/instanceId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.packageDigest !== undefined){
const _errs10 = errors;
if(typeof data.packageDigest !== "string"){
validate27.errors = [{instancePath:instancePath+"/packageDigest",schemaPath:"#/properties/packageDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.plugin !== undefined){
let data5 = data.plugin;
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(data5 && typeof data5 == "object" && !Array.isArray(data5)){
let missing1;
if((((data5.publisher === undefined) && (missing1 = "publisher")) || ((data5.id === undefined) && (missing1 = "id"))) || ((data5.version === undefined) && (missing1 = "version"))){
validate27.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs15 = errors;
for(const key1 in data5){
if(!(((key1 === "id") || (key1 === "publisher")) || (key1 === "version"))){
validate27.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs15 === errors){
if(data5.id !== undefined){
const _errs16 = errors;
if(typeof data5.id !== "string"){
validate27.errors = [{instancePath:instancePath+"/plugin/id",schemaPath:"#/$defs/PluginIdentity/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs16 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data5.publisher !== undefined){
const _errs18 = errors;
if(typeof data5.publisher !== "string"){
validate27.errors = [{instancePath:instancePath+"/plugin/publisher",schemaPath:"#/$defs/PluginIdentity/properties/publisher/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs18 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data5.version !== undefined){
const _errs20 = errors;
if(typeof data5.version !== "string"){
validate27.errors = [{instancePath:instancePath+"/plugin/version",schemaPath:"#/$defs/PluginIdentity/properties/version/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs20 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate27.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs12 === errors;
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
}
else {
validate27.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate27.errors = vErrors;
return errors === 0;
}
validate27.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema46 = {"description":"A Host-selected service descriptor, not a grant or a project/store handle.\nThe Host authenticates its provider, scope, configuration and live generation.","type":"object","properties":{"activationGeneration":{"type":"integer","maximum":4294967295,"minimum":1},"configurationDigest":{"type":"string"},"contract":{"$ref":"#/$defs/ContractRef"},"effect":{"$ref":"#/$defs/EffectKind"},"errorSchema":{"$ref":"#/$defs/ContractRef"},"handleId":{"type":"string"},"inputSchema":{"$ref":"#/$defs/ContractRef"},"limits":{"$ref":"#/$defs/CapabilityLimits"},"outputSchema":{"$ref":"#/$defs/ContractRef"},"projectId":{"type":"string"},"providerId":{"type":"string"},"scopeId":{"type":"string"}},"additionalProperties":false,"required":["handleId","providerId","contract","inputSchema","outputSchema","errorSchema","effect","projectId","scopeId","activationGeneration","configurationDigest","limits"]};
const func1 = Object.prototype.hasOwnProperty;

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
if(((((((((((((data.handleId === undefined) && (missing0 = "handleId")) || ((data.providerId === undefined) && (missing0 = "providerId"))) || ((data.contract === undefined) && (missing0 = "contract"))) || ((data.inputSchema === undefined) && (missing0 = "inputSchema"))) || ((data.outputSchema === undefined) && (missing0 = "outputSchema"))) || ((data.errorSchema === undefined) && (missing0 = "errorSchema"))) || ((data.effect === undefined) && (missing0 = "effect"))) || ((data.projectId === undefined) && (missing0 = "projectId"))) || ((data.scopeId === undefined) && (missing0 = "scopeId"))) || ((data.activationGeneration === undefined) && (missing0 = "activationGeneration"))) || ((data.configurationDigest === undefined) && (missing0 = "configurationDigest"))) || ((data.limits === undefined) && (missing0 = "limits"))){
validate29.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(func1.call(schema46.properties, key0))){
validate29.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.activationGeneration !== undefined){
let data0 = data.activationGeneration;
const _errs2 = errors;
if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){
validate29.errors = [{instancePath:instancePath+"/activationGeneration",schemaPath:"#/properties/activationGeneration/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs2){
if((typeof data0 == "number") && (isFinite(data0))){
if(data0 > 4294967295 || isNaN(data0)){
validate29.errors = [{instancePath:instancePath+"/activationGeneration",schemaPath:"#/properties/activationGeneration/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data0 < 1 || isNaN(data0)){
validate29.errors = [{instancePath:instancePath+"/activationGeneration",schemaPath:"#/properties/activationGeneration/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
if(data.configurationDigest !== undefined){
const _errs4 = errors;
if(typeof data.configurationDigest !== "string"){
validate29.errors = [{instancePath:instancePath+"/configurationDigest",schemaPath:"#/properties/configurationDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.contract !== undefined){
let data2 = data.contract;
const _errs6 = errors;
const _errs7 = errors;
if(errors === _errs7){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing1;
if((((data2.id === undefined) && (missing1 = "id")) || ((data2.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data2.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate29.errors = [{instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs9 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate29.errors = [{instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs9 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate29.errors = [{instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate29.errors = [{instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate29.errors = [{instancePath:instancePath+"/contract/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data2.id !== undefined){
const _errs12 = errors;
if(typeof data2.id !== "string"){
validate29.errors = [{instancePath:instancePath+"/contract/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data2.schemaVersion !== undefined){
let data5 = data2.schemaVersion;
const _errs14 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
validate29.errors = [{instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs14){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate29.errors = [{instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate29.errors = [{instancePath:instancePath+"/contract/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs14 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate29.errors = [{instancePath:instancePath+"/contract",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.effect !== undefined){
let data6 = data.effect;
const _errs16 = errors;
if(typeof data6 !== "string"){
validate29.errors = [{instancePath:instancePath+"/effect",schemaPath:"#/$defs/EffectKind/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data6 === "read-only") || (data6 === "proposal")) || (data6 === "external"))){
validate29.errors = [{instancePath:instancePath+"/effect",schemaPath:"#/$defs/EffectKind/enum",keyword:"enum",params:{allowedValues: schema36.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs16 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.errorSchema !== undefined){
let data7 = data.errorSchema;
const _errs19 = errors;
const _errs20 = errors;
if(errors === _errs20){
if(data7 && typeof data7 == "object" && !Array.isArray(data7)){
let missing2;
if((((data7.id === undefined) && (missing2 = "id")) || ((data7.schemaVersion === undefined) && (missing2 = "schemaVersion"))) || ((data7.behaviorVersion === undefined) && (missing2 = "behaviorVersion"))){
validate29.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs22 = errors;
for(const key2 in data7){
if(!(((key2 === "behaviorVersion") || (key2 === "id")) || (key2 === "schemaVersion"))){
validate29.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs22 === errors){
if(data7.behaviorVersion !== undefined){
let data8 = data7.behaviorVersion;
const _errs23 = errors;
if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){
validate29.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs23){
if((typeof data8 == "number") && (isFinite(data8))){
if(data8 > 4294967295 || isNaN(data8)){
validate29.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data8 < 1 || isNaN(data8)){
validate29.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid5 = _errs23 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data7.id !== undefined){
const _errs25 = errors;
if(typeof data7.id !== "string"){
validate29.errors = [{instancePath:instancePath+"/errorSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid5 = _errs25 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data7.schemaVersion !== undefined){
let data10 = data7.schemaVersion;
const _errs27 = errors;
if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){
validate29.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs27){
if((typeof data10 == "number") && (isFinite(data10))){
if(data10 > 4294967295 || isNaN(data10)){
validate29.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data10 < 1 || isNaN(data10)){
validate29.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid5 = _errs27 === errors;
}
else {
var valid5 = true;
}
}
}
}
}
}
else {
validate29.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs19 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.handleId !== undefined){
const _errs29 = errors;
if(typeof data.handleId !== "string"){
validate29.errors = [{instancePath:instancePath+"/handleId",schemaPath:"#/properties/handleId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs29 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.inputSchema !== undefined){
let data12 = data.inputSchema;
const _errs31 = errors;
const _errs32 = errors;
if(errors === _errs32){
if(data12 && typeof data12 == "object" && !Array.isArray(data12)){
let missing3;
if((((data12.id === undefined) && (missing3 = "id")) || ((data12.schemaVersion === undefined) && (missing3 = "schemaVersion"))) || ((data12.behaviorVersion === undefined) && (missing3 = "behaviorVersion"))){
validate29.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"}];
return false;
}
else {
const _errs34 = errors;
for(const key3 in data12){
if(!(((key3 === "behaviorVersion") || (key3 === "id")) || (key3 === "schemaVersion"))){
validate29.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs34 === errors){
if(data12.behaviorVersion !== undefined){
let data13 = data12.behaviorVersion;
const _errs35 = errors;
if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){
validate29.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs35){
if((typeof data13 == "number") && (isFinite(data13))){
if(data13 > 4294967295 || isNaN(data13)){
validate29.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data13 < 1 || isNaN(data13)){
validate29.errors = [{instancePath:instancePath+"/inputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid7 = _errs35 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data12.id !== undefined){
const _errs37 = errors;
if(typeof data12.id !== "string"){
validate29.errors = [{instancePath:instancePath+"/inputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs37 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data12.schemaVersion !== undefined){
let data15 = data12.schemaVersion;
const _errs39 = errors;
if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){
validate29.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs39){
if((typeof data15 == "number") && (isFinite(data15))){
if(data15 > 4294967295 || isNaN(data15)){
validate29.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data15 < 1 || isNaN(data15)){
validate29.errors = [{instancePath:instancePath+"/inputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid7 = _errs39 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
}
else {
validate29.errors = [{instancePath:instancePath+"/inputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs31 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.limits !== undefined){
let data16 = data.limits;
const _errs41 = errors;
const _errs42 = errors;
if(errors === _errs42){
if(data16 && typeof data16 == "object" && !Array.isArray(data16)){
let missing4;
if(((((data16.maxInputBytes === undefined) && (missing4 = "maxInputBytes")) || ((data16.maxOutputBytes === undefined) && (missing4 = "maxOutputBytes"))) || ((data16.concurrency === undefined) && (missing4 = "concurrency"))) || ((data16.timeoutMs === undefined) && (missing4 = "timeoutMs"))){
validate29.errors = [{instancePath:instancePath+"/limits",schemaPath:"#/$defs/CapabilityLimits/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"}];
return false;
}
else {
const _errs44 = errors;
for(const key4 in data16){
if(!((((key4 === "concurrency") || (key4 === "maxInputBytes")) || (key4 === "maxOutputBytes")) || (key4 === "timeoutMs"))){
validate29.errors = [{instancePath:instancePath+"/limits",schemaPath:"#/$defs/CapabilityLimits/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs44 === errors){
if(data16.concurrency !== undefined){
let data17 = data16.concurrency;
const _errs45 = errors;
if(!(((typeof data17 == "number") && (!(data17 % 1) && !isNaN(data17))) && (isFinite(data17)))){
validate29.errors = [{instancePath:instancePath+"/limits/concurrency",schemaPath:"#/$defs/CapabilityLimits/properties/concurrency/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs45){
if((typeof data17 == "number") && (isFinite(data17))){
if(data17 > 65535 || isNaN(data17)){
validate29.errors = [{instancePath:instancePath+"/limits/concurrency",schemaPath:"#/$defs/CapabilityLimits/properties/concurrency/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535},message:"must be <= 65535"}];
return false;
}
else {
if(data17 < 1 || isNaN(data17)){
validate29.errors = [{instancePath:instancePath+"/limits/concurrency",schemaPath:"#/$defs/CapabilityLimits/properties/concurrency/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs45 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data16.maxInputBytes !== undefined){
let data18 = data16.maxInputBytes;
const _errs47 = errors;
if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){
validate29.errors = [{instancePath:instancePath+"/limits/maxInputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxInputBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs47){
if((typeof data18 == "number") && (isFinite(data18))){
if(data18 > 4294967295 || isNaN(data18)){
validate29.errors = [{instancePath:instancePath+"/limits/maxInputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxInputBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data18 < 1 || isNaN(data18)){
validate29.errors = [{instancePath:instancePath+"/limits/maxInputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxInputBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs47 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data16.maxOutputBytes !== undefined){
let data19 = data16.maxOutputBytes;
const _errs49 = errors;
if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){
validate29.errors = [{instancePath:instancePath+"/limits/maxOutputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxOutputBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs49){
if((typeof data19 == "number") && (isFinite(data19))){
if(data19 > 4294967295 || isNaN(data19)){
validate29.errors = [{instancePath:instancePath+"/limits/maxOutputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxOutputBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data19 < 1 || isNaN(data19)){
validate29.errors = [{instancePath:instancePath+"/limits/maxOutputBytes",schemaPath:"#/$defs/CapabilityLimits/properties/maxOutputBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs49 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data16.timeoutMs !== undefined){
let data20 = data16.timeoutMs;
const _errs51 = errors;
if(!(((typeof data20 == "number") && (!(data20 % 1) && !isNaN(data20))) && (isFinite(data20)))){
validate29.errors = [{instancePath:instancePath+"/limits/timeoutMs",schemaPath:"#/$defs/CapabilityLimits/properties/timeoutMs/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs51){
if((typeof data20 == "number") && (isFinite(data20))){
if(data20 > 4294967295 || isNaN(data20)){
validate29.errors = [{instancePath:instancePath+"/limits/timeoutMs",schemaPath:"#/$defs/CapabilityLimits/properties/timeoutMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data20 < 1 || isNaN(data20)){
validate29.errors = [{instancePath:instancePath+"/limits/timeoutMs",schemaPath:"#/$defs/CapabilityLimits/properties/timeoutMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid9 = _errs51 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
}
}
else {
validate29.errors = [{instancePath:instancePath+"/limits",schemaPath:"#/$defs/CapabilityLimits/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs41 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outputSchema !== undefined){
let data21 = data.outputSchema;
const _errs53 = errors;
const _errs54 = errors;
if(errors === _errs54){
if(data21 && typeof data21 == "object" && !Array.isArray(data21)){
let missing5;
if((((data21.id === undefined) && (missing5 = "id")) || ((data21.schemaVersion === undefined) && (missing5 = "schemaVersion"))) || ((data21.behaviorVersion === undefined) && (missing5 = "behaviorVersion"))){
validate29.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"}];
return false;
}
else {
const _errs56 = errors;
for(const key5 in data21){
if(!(((key5 === "behaviorVersion") || (key5 === "id")) || (key5 === "schemaVersion"))){
validate29.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs56 === errors){
if(data21.behaviorVersion !== undefined){
let data22 = data21.behaviorVersion;
const _errs57 = errors;
if(!(((typeof data22 == "number") && (!(data22 % 1) && !isNaN(data22))) && (isFinite(data22)))){
validate29.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs57){
if((typeof data22 == "number") && (isFinite(data22))){
if(data22 > 4294967295 || isNaN(data22)){
validate29.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data22 < 1 || isNaN(data22)){
validate29.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid11 = _errs57 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data21.id !== undefined){
const _errs59 = errors;
if(typeof data21.id !== "string"){
validate29.errors = [{instancePath:instancePath+"/outputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid11 = _errs59 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data21.schemaVersion !== undefined){
let data24 = data21.schemaVersion;
const _errs61 = errors;
if(!(((typeof data24 == "number") && (!(data24 % 1) && !isNaN(data24))) && (isFinite(data24)))){
validate29.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs61){
if((typeof data24 == "number") && (isFinite(data24))){
if(data24 > 4294967295 || isNaN(data24)){
validate29.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data24 < 1 || isNaN(data24)){
validate29.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid11 = _errs61 === errors;
}
else {
var valid11 = true;
}
}
}
}
}
}
else {
validate29.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs53 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.projectId !== undefined){
const _errs63 = errors;
if(typeof data.projectId !== "string"){
validate29.errors = [{instancePath:instancePath+"/projectId",schemaPath:"#/properties/projectId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs63 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.providerId !== undefined){
const _errs65 = errors;
if(typeof data.providerId !== "string"){
validate29.errors = [{instancePath:instancePath+"/providerId",schemaPath:"#/properties/providerId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs65 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.scopeId !== undefined){
const _errs67 = errors;
if(typeof data.scopeId !== "string"){
validate29.errors = [{instancePath:instancePath+"/scopeId",schemaPath:"#/properties/scopeId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs67 === errors;
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
}
}
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
if((((data.provider === undefined) && (missing0 = "provider")) || ((data.capability === undefined) && (missing0 = "capability"))) || ((data.services === undefined) && (missing0 = "services"))){
validate22.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "capability") || (key0 === "provider")) || (key0 === "services"))){
validate22.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.capability !== undefined){
const _errs2 = errors;
if(!(validate23(data.capability, {instancePath:instancePath+"/capability",parentData:data,parentDataProperty:"capability",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate23.errors : vErrors.concat(validate23.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.provider !== undefined){
const _errs3 = errors;
if(!(validate27(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate27.errors : vErrors.concat(validate27.errors);
errors = vErrors.length;
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.services !== undefined){
let data2 = data.services;
const _errs4 = errors;
if(errors === _errs4){
if(Array.isArray(data2)){
var valid1 = true;
const len0 = data2.length;
for(let i0=0; i0<len0; i0++){
const _errs6 = errors;
if(!(validate29(data2[i0], {instancePath:instancePath+"/services/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate29.errors : vErrors.concat(validate29.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate22.errors = [{instancePath:instancePath+"/services",schemaPath:"#/properties/services/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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

const schema53 = {"type":"object","properties":{"capability":{"$ref":"#/$defs/ContractRef"},"context":{"$ref":"#/$defs/InvocationContext"},"errorSchema":{"$ref":"#/$defs/ContractRef"},"input":{"$ref":"#/$defs/EncodedPayload"},"maxResultBytes":{"type":"integer","maximum":4294967295,"minimum":1},"outputSchema":{"$ref":"#/$defs/ContractRef"},"profile":{"anyOf":[{"$ref":"#/$defs/ContractRef"},{"type":"null"}]},"provider":{"$ref":"#/$defs/ProviderBinding"}},"additionalProperties":false,"required":["context","provider","capability","input","outputSchema","errorSchema","maxResultBytes"]};
const schema55 = {"type":"object","properties":{"attemptId":{"type":"string"},"configurationDigest":{"type":"string"},"dispatchId":{"type":"string"},"environmentDigest":{"type":"string"},"inputDigest":{"type":"string"},"itemId":{"type":"string"},"operationId":{"type":"string"},"projectId":{"type":"string"},"scopeDigest":{"type":"string"},"scopeId":{"type":"string"}},"additionalProperties":false,"required":["projectId","operationId","attemptId","itemId","dispatchId","scopeId","inputDigest","scopeDigest","environmentDigest","configurationDigest"]};
const schema57 = {"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]};

function validate34(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate34.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.schema === undefined) && (missing0 = "schema")) || ((data.utf8 === undefined) && (missing0 = "utf8"))) || ((data.sha256 === undefined) && (missing0 = "sha256"))){
validate34.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "schema") || (key0 === "sha256")) || (key0 === "utf8"))){
validate34.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.schema !== undefined){
let data0 = data.schema;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate34.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate34.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate34.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate34.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate34.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.id !== undefined){
const _errs8 = errors;
if(typeof data0.id !== "string"){
validate34.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.schemaVersion !== undefined){
let data3 = data0.schemaVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate34.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate34.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate34.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate34.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sha256 !== undefined){
const _errs12 = errors;
if(typeof data.sha256 !== "string"){
validate34.errors = [{instancePath:instancePath+"/sha256",schemaPath:"#/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.utf8 !== undefined){
const _errs14 = errors;
if(typeof data.utf8 !== "string"){
validate34.errors = [{instancePath:instancePath+"/utf8",schemaPath:"#/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs14 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
else {
validate34.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate34.errors = vErrors;
return errors === 0;
}
validate34.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate33(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate33.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((((data.context === undefined) && (missing0 = "context")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.capability === undefined) && (missing0 = "capability"))) || ((data.input === undefined) && (missing0 = "input"))) || ((data.outputSchema === undefined) && (missing0 = "outputSchema"))) || ((data.errorSchema === undefined) && (missing0 = "errorSchema"))) || ((data.maxResultBytes === undefined) && (missing0 = "maxResultBytes"))){
validate33.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "capability") || (key0 === "context")) || (key0 === "errorSchema")) || (key0 === "input")) || (key0 === "maxResultBytes")) || (key0 === "outputSchema")) || (key0 === "profile")) || (key0 === "provider"))){
validate33.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.capability !== undefined){
let data0 = data.capability;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate33.errors = [{instancePath:instancePath+"/capability",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate33.errors = [{instancePath:instancePath+"/capability",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate33.errors = [{instancePath:instancePath+"/capability/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate33.errors = [{instancePath:instancePath+"/capability/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate33.errors = [{instancePath:instancePath+"/capability/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.id !== undefined){
const _errs8 = errors;
if(typeof data0.id !== "string"){
validate33.errors = [{instancePath:instancePath+"/capability/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.schemaVersion !== undefined){
let data3 = data0.schemaVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate33.errors = [{instancePath:instancePath+"/capability/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate33.errors = [{instancePath:instancePath+"/capability/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate33.errors = [{instancePath:instancePath+"/capability/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate33.errors = [{instancePath:instancePath+"/capability",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.context !== undefined){
let data4 = data.context;
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(data4 && typeof data4 == "object" && !Array.isArray(data4)){
let missing2;
if(((((((((((data4.projectId === undefined) && (missing2 = "projectId")) || ((data4.operationId === undefined) && (missing2 = "operationId"))) || ((data4.attemptId === undefined) && (missing2 = "attemptId"))) || ((data4.itemId === undefined) && (missing2 = "itemId"))) || ((data4.dispatchId === undefined) && (missing2 = "dispatchId"))) || ((data4.scopeId === undefined) && (missing2 = "scopeId"))) || ((data4.inputDigest === undefined) && (missing2 = "inputDigest"))) || ((data4.scopeDigest === undefined) && (missing2 = "scopeDigest"))) || ((data4.environmentDigest === undefined) && (missing2 = "environmentDigest"))) || ((data4.configurationDigest === undefined) && (missing2 = "configurationDigest"))){
validate33.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs15 = errors;
for(const key2 in data4){
if(!(func1.call(schema55.properties, key2))){
validate33.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs15 === errors){
if(data4.attemptId !== undefined){
const _errs16 = errors;
if(typeof data4.attemptId !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/attemptId",schemaPath:"#/$defs/InvocationContext/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs16 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.configurationDigest !== undefined){
const _errs18 = errors;
if(typeof data4.configurationDigest !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/configurationDigest",schemaPath:"#/$defs/InvocationContext/properties/configurationDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs18 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.dispatchId !== undefined){
const _errs20 = errors;
if(typeof data4.dispatchId !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/dispatchId",schemaPath:"#/$defs/InvocationContext/properties/dispatchId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs20 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.environmentDigest !== undefined){
const _errs22 = errors;
if(typeof data4.environmentDigest !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/environmentDigest",schemaPath:"#/$defs/InvocationContext/properties/environmentDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs22 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.inputDigest !== undefined){
const _errs24 = errors;
if(typeof data4.inputDigest !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/inputDigest",schemaPath:"#/$defs/InvocationContext/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs24 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.itemId !== undefined){
const _errs26 = errors;
if(typeof data4.itemId !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/itemId",schemaPath:"#/$defs/InvocationContext/properties/itemId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs26 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.operationId !== undefined){
const _errs28 = errors;
if(typeof data4.operationId !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/operationId",schemaPath:"#/$defs/InvocationContext/properties/operationId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs28 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.projectId !== undefined){
const _errs30 = errors;
if(typeof data4.projectId !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/projectId",schemaPath:"#/$defs/InvocationContext/properties/projectId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs30 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.scopeDigest !== undefined){
const _errs32 = errors;
if(typeof data4.scopeDigest !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/scopeDigest",schemaPath:"#/$defs/InvocationContext/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs32 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.scopeId !== undefined){
const _errs34 = errors;
if(typeof data4.scopeId !== "string"){
validate33.errors = [{instancePath:instancePath+"/context/scopeId",schemaPath:"#/$defs/InvocationContext/properties/scopeId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs34 === errors;
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
}
}
}
}
}
else {
validate33.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.errorSchema !== undefined){
let data15 = data.errorSchema;
const _errs36 = errors;
const _errs37 = errors;
if(errors === _errs37){
if(data15 && typeof data15 == "object" && !Array.isArray(data15)){
let missing3;
if((((data15.id === undefined) && (missing3 = "id")) || ((data15.schemaVersion === undefined) && (missing3 = "schemaVersion"))) || ((data15.behaviorVersion === undefined) && (missing3 = "behaviorVersion"))){
validate33.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"}];
return false;
}
else {
const _errs39 = errors;
for(const key3 in data15){
if(!(((key3 === "behaviorVersion") || (key3 === "id")) || (key3 === "schemaVersion"))){
validate33.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs39 === errors){
if(data15.behaviorVersion !== undefined){
let data16 = data15.behaviorVersion;
const _errs40 = errors;
if(!(((typeof data16 == "number") && (!(data16 % 1) && !isNaN(data16))) && (isFinite(data16)))){
validate33.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs40){
if((typeof data16 == "number") && (isFinite(data16))){
if(data16 > 4294967295 || isNaN(data16)){
validate33.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data16 < 1 || isNaN(data16)){
validate33.errors = [{instancePath:instancePath+"/errorSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid6 = _errs40 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data15.id !== undefined){
const _errs42 = errors;
if(typeof data15.id !== "string"){
validate33.errors = [{instancePath:instancePath+"/errorSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid6 = _errs42 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data15.schemaVersion !== undefined){
let data18 = data15.schemaVersion;
const _errs44 = errors;
if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){
validate33.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs44){
if((typeof data18 == "number") && (isFinite(data18))){
if(data18 > 4294967295 || isNaN(data18)){
validate33.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data18 < 1 || isNaN(data18)){
validate33.errors = [{instancePath:instancePath+"/errorSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid6 = _errs44 === errors;
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
validate33.errors = [{instancePath:instancePath+"/errorSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs36 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.input !== undefined){
const _errs46 = errors;
if(!(validate34(data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
errors = vErrors.length;
}
var valid0 = _errs46 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.maxResultBytes !== undefined){
let data20 = data.maxResultBytes;
const _errs47 = errors;
if(!(((typeof data20 == "number") && (!(data20 % 1) && !isNaN(data20))) && (isFinite(data20)))){
validate33.errors = [{instancePath:instancePath+"/maxResultBytes",schemaPath:"#/properties/maxResultBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs47){
if((typeof data20 == "number") && (isFinite(data20))){
if(data20 > 4294967295 || isNaN(data20)){
validate33.errors = [{instancePath:instancePath+"/maxResultBytes",schemaPath:"#/properties/maxResultBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data20 < 1 || isNaN(data20)){
validate33.errors = [{instancePath:instancePath+"/maxResultBytes",schemaPath:"#/properties/maxResultBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid0 = _errs47 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outputSchema !== undefined){
let data21 = data.outputSchema;
const _errs49 = errors;
const _errs50 = errors;
if(errors === _errs50){
if(data21 && typeof data21 == "object" && !Array.isArray(data21)){
let missing4;
if((((data21.id === undefined) && (missing4 = "id")) || ((data21.schemaVersion === undefined) && (missing4 = "schemaVersion"))) || ((data21.behaviorVersion === undefined) && (missing4 = "behaviorVersion"))){
validate33.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"}];
return false;
}
else {
const _errs52 = errors;
for(const key4 in data21){
if(!(((key4 === "behaviorVersion") || (key4 === "id")) || (key4 === "schemaVersion"))){
validate33.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs52 === errors){
if(data21.behaviorVersion !== undefined){
let data22 = data21.behaviorVersion;
const _errs53 = errors;
if(!(((typeof data22 == "number") && (!(data22 % 1) && !isNaN(data22))) && (isFinite(data22)))){
validate33.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs53){
if((typeof data22 == "number") && (isFinite(data22))){
if(data22 > 4294967295 || isNaN(data22)){
validate33.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data22 < 1 || isNaN(data22)){
validate33.errors = [{instancePath:instancePath+"/outputSchema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid8 = _errs53 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data21.id !== undefined){
const _errs55 = errors;
if(typeof data21.id !== "string"){
validate33.errors = [{instancePath:instancePath+"/outputSchema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid8 = _errs55 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data21.schemaVersion !== undefined){
let data24 = data21.schemaVersion;
const _errs57 = errors;
if(!(((typeof data24 == "number") && (!(data24 % 1) && !isNaN(data24))) && (isFinite(data24)))){
validate33.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs57){
if((typeof data24 == "number") && (isFinite(data24))){
if(data24 > 4294967295 || isNaN(data24)){
validate33.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data24 < 1 || isNaN(data24)){
validate33.errors = [{instancePath:instancePath+"/outputSchema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid8 = _errs57 === errors;
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
validate33.errors = [{instancePath:instancePath+"/outputSchema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs49 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data25 = data.profile;
const _errs59 = errors;
const _errs60 = errors;
let valid9 = false;
const _errs61 = errors;
const _errs62 = errors;
if(errors === _errs62){
if(data25 && typeof data25 == "object" && !Array.isArray(data25)){
let missing5;
if((((data25.id === undefined) && (missing5 = "id")) || ((data25.schemaVersion === undefined) && (missing5 = "schemaVersion"))) || ((data25.behaviorVersion === undefined) && (missing5 = "behaviorVersion"))){
const err0 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs64 = errors;
for(const key5 in data25){
if(!(((key5 === "behaviorVersion") || (key5 === "id")) || (key5 === "schemaVersion"))){
const err1 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
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
if(_errs64 === errors){
if(data25.behaviorVersion !== undefined){
let data26 = data25.behaviorVersion;
const _errs65 = errors;
if(!(((typeof data26 == "number") && (!(data26 % 1) && !isNaN(data26))) && (isFinite(data26)))){
const err2 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(errors === _errs65){
if((typeof data26 == "number") && (isFinite(data26))){
if(data26 > 4294967295 || isNaN(data26)){
const err3 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
else {
if(data26 < 1 || isNaN(data26)){
const err4 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
}
}
var valid11 = _errs65 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data25.id !== undefined){
const _errs67 = errors;
if(typeof data25.id !== "string"){
const err5 = {instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid11 = _errs67 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data25.schemaVersion !== undefined){
let data28 = data25.schemaVersion;
const _errs69 = errors;
if(!(((typeof data28 == "number") && (!(data28 % 1) && !isNaN(data28))) && (isFinite(data28)))){
const err6 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs69){
if((typeof data28 == "number") && (isFinite(data28))){
if(data28 > 4294967295 || isNaN(data28)){
const err7 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data28 < 1 || isNaN(data28)){
const err8 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
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
var valid11 = _errs69 === errors;
}
else {
var valid11 = true;
}
}
}
}
}
}
else {
const err9 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
var _valid0 = _errs61 === errors;
valid9 = valid9 || _valid0;
const _errs71 = errors;
if(data25 !== null){
const err10 = {instancePath:instancePath+"/profile",schemaPath:"#/properties/profile/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var _valid0 = _errs71 === errors;
valid9 = valid9 || _valid0;
if(!valid9){
const err11 = {instancePath:instancePath+"/profile",schemaPath:"#/properties/profile/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
validate33.errors = vErrors;
return false;
}
else {
errors = _errs60;
if(vErrors !== null){
if(_errs60){
vErrors.length = _errs60;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs59 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.provider !== undefined){
const _errs73 = errors;
if(!(validate27(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate27.errors : vErrors.concat(validate27.errors);
errors = vErrors.length;
}
var valid0 = _errs73 === errors;
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
}
}
}
else {
validate33.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate33.errors = vErrors;
return errors === 0;
}
validate33.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema61 = {"type":"object","properties":{"capability":{"$ref":"#/$defs/ContractRef"},"context":{"$ref":"#/$defs/InvocationContext"},"outcome":{"$ref":"#/$defs/InvocationOutcome"},"profile":{"anyOf":[{"$ref":"#/$defs/ContractRef"},{"type":"null"}]},"provider":{"$ref":"#/$defs/ProviderBinding"},"resultId":{"type":"string"}},"additionalProperties":false,"required":["context","provider","capability","resultId","outcome"]};
const schema64 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"succeeded"},"output":{"$ref":"#/$defs/EncodedPayload"}},"additionalProperties":false,"required":["kind","output"]},{"type":"object","properties":{"error":{"$ref":"#/$defs/EncodedPayload"},"kind":{"type":"string","const":"failed"}},"additionalProperties":false,"required":["kind","error"]},{"type":"object","properties":{"error":{"$ref":"#/$defs/EncodedPayload"},"kind":{"type":"string","const":"unknown"}},"additionalProperties":false,"required":["kind","error"]}]};

function validate39(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate39.evaluated;
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
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.output === undefined) && (missing0 = "output"))){
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
if(!((key0 === "kind") || (key0 === "output"))){
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
if("succeeded" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "succeeded"},message:"must be equal to constant"};
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
if(data.output !== undefined){
const _errs6 = errors;
if(!(validate34(data.output, {instancePath:instancePath+"/output",parentData:data,parentDataProperty:"output",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
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
const _errs7 = errors;
if(errors === _errs7){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if(((data.kind === undefined) && (missing1 = "kind")) || ((data.error === undefined) && (missing1 = "error"))){
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
const _errs9 = errors;
for(const key1 in data){
if(!((key1 === "error") || (key1 === "kind"))){
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
if(_errs9 === errors){
if(data.error !== undefined){
const _errs10 = errors;
if(!(validate34(data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
errors = vErrors.length;
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.kind !== undefined){
let data3 = data.kind;
const _errs11 = errors;
if(typeof data3 !== "string"){
const err7 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if("failed" !== data3){
const err8 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "failed"},message:"must be equal to constant"};
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
}
}
}
}
else {
const err9 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
var _valid0 = _errs7 === errors;
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
const _errs13 = errors;
if(errors === _errs13){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if(((data.kind === undefined) && (missing2 = "kind")) || ((data.error === undefined) && (missing2 = "error"))){
const err10 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
else {
const _errs15 = errors;
for(const key2 in data){
if(!((key2 === "error") || (key2 === "kind"))){
const err11 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
break;
}
}
if(_errs15 === errors){
if(data.error !== undefined){
const _errs16 = errors;
if(!(validate34(data.error, {instancePath:instancePath+"/error",parentData:data,parentDataProperty:"error",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
errors = vErrors.length;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs17 = errors;
if(typeof data5 !== "string"){
const err12 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
if("unknown" !== data5){
const err13 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "unknown"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
var valid3 = _errs17 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
const err14 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
var _valid0 = _errs13 === errors;
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
}
}
if(!valid0){
const err15 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
validate39.errors = vErrors;
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
validate39.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate39.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate38(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate38.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.context === undefined) && (missing0 = "context")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.capability === undefined) && (missing0 = "capability"))) || ((data.resultId === undefined) && (missing0 = "resultId"))) || ((data.outcome === undefined) && (missing0 = "outcome"))){
validate38.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((key0 === "capability") || (key0 === "context")) || (key0 === "outcome")) || (key0 === "profile")) || (key0 === "provider")) || (key0 === "resultId"))){
validate38.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.capability !== undefined){
let data0 = data.capability;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate38.errors = [{instancePath:instancePath+"/capability",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate38.errors = [{instancePath:instancePath+"/capability",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate38.errors = [{instancePath:instancePath+"/capability/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate38.errors = [{instancePath:instancePath+"/capability/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate38.errors = [{instancePath:instancePath+"/capability/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.id !== undefined){
const _errs8 = errors;
if(typeof data0.id !== "string"){
validate38.errors = [{instancePath:instancePath+"/capability/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.schemaVersion !== undefined){
let data3 = data0.schemaVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate38.errors = [{instancePath:instancePath+"/capability/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate38.errors = [{instancePath:instancePath+"/capability/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate38.errors = [{instancePath:instancePath+"/capability/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate38.errors = [{instancePath:instancePath+"/capability",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.context !== undefined){
let data4 = data.context;
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(data4 && typeof data4 == "object" && !Array.isArray(data4)){
let missing2;
if(((((((((((data4.projectId === undefined) && (missing2 = "projectId")) || ((data4.operationId === undefined) && (missing2 = "operationId"))) || ((data4.attemptId === undefined) && (missing2 = "attemptId"))) || ((data4.itemId === undefined) && (missing2 = "itemId"))) || ((data4.dispatchId === undefined) && (missing2 = "dispatchId"))) || ((data4.scopeId === undefined) && (missing2 = "scopeId"))) || ((data4.inputDigest === undefined) && (missing2 = "inputDigest"))) || ((data4.scopeDigest === undefined) && (missing2 = "scopeDigest"))) || ((data4.environmentDigest === undefined) && (missing2 = "environmentDigest"))) || ((data4.configurationDigest === undefined) && (missing2 = "configurationDigest"))){
validate38.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs15 = errors;
for(const key2 in data4){
if(!(func1.call(schema55.properties, key2))){
validate38.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs15 === errors){
if(data4.attemptId !== undefined){
const _errs16 = errors;
if(typeof data4.attemptId !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/attemptId",schemaPath:"#/$defs/InvocationContext/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs16 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.configurationDigest !== undefined){
const _errs18 = errors;
if(typeof data4.configurationDigest !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/configurationDigest",schemaPath:"#/$defs/InvocationContext/properties/configurationDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs18 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.dispatchId !== undefined){
const _errs20 = errors;
if(typeof data4.dispatchId !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/dispatchId",schemaPath:"#/$defs/InvocationContext/properties/dispatchId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs20 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.environmentDigest !== undefined){
const _errs22 = errors;
if(typeof data4.environmentDigest !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/environmentDigest",schemaPath:"#/$defs/InvocationContext/properties/environmentDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs22 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.inputDigest !== undefined){
const _errs24 = errors;
if(typeof data4.inputDigest !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/inputDigest",schemaPath:"#/$defs/InvocationContext/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs24 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.itemId !== undefined){
const _errs26 = errors;
if(typeof data4.itemId !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/itemId",schemaPath:"#/$defs/InvocationContext/properties/itemId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs26 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.operationId !== undefined){
const _errs28 = errors;
if(typeof data4.operationId !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/operationId",schemaPath:"#/$defs/InvocationContext/properties/operationId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs28 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.projectId !== undefined){
const _errs30 = errors;
if(typeof data4.projectId !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/projectId",schemaPath:"#/$defs/InvocationContext/properties/projectId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs30 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.scopeDigest !== undefined){
const _errs32 = errors;
if(typeof data4.scopeDigest !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/scopeDigest",schemaPath:"#/$defs/InvocationContext/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs32 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.scopeId !== undefined){
const _errs34 = errors;
if(typeof data4.scopeId !== "string"){
validate38.errors = [{instancePath:instancePath+"/context/scopeId",schemaPath:"#/$defs/InvocationContext/properties/scopeId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs34 === errors;
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
}
}
}
}
}
else {
validate38.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outcome !== undefined){
const _errs36 = errors;
if(!(validate39(data.outcome, {instancePath:instancePath+"/outcome",parentData:data,parentDataProperty:"outcome",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate39.errors : vErrors.concat(validate39.errors);
errors = vErrors.length;
}
var valid0 = _errs36 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data16 = data.profile;
const _errs37 = errors;
const _errs38 = errors;
let valid5 = false;
const _errs39 = errors;
const _errs40 = errors;
if(errors === _errs40){
if(data16 && typeof data16 == "object" && !Array.isArray(data16)){
let missing3;
if((((data16.id === undefined) && (missing3 = "id")) || ((data16.schemaVersion === undefined) && (missing3 = "schemaVersion"))) || ((data16.behaviorVersion === undefined) && (missing3 = "behaviorVersion"))){
const err0 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs42 = errors;
for(const key3 in data16){
if(!(((key3 === "behaviorVersion") || (key3 === "id")) || (key3 === "schemaVersion"))){
const err1 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
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
if(_errs42 === errors){
if(data16.behaviorVersion !== undefined){
let data17 = data16.behaviorVersion;
const _errs43 = errors;
if(!(((typeof data17 == "number") && (!(data17 % 1) && !isNaN(data17))) && (isFinite(data17)))){
const err2 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if(errors === _errs43){
if((typeof data17 == "number") && (isFinite(data17))){
if(data17 > 4294967295 || isNaN(data17)){
const err3 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
else {
if(data17 < 1 || isNaN(data17)){
const err4 = {instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
}
}
var valid7 = _errs43 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data16.id !== undefined){
const _errs45 = errors;
if(typeof data16.id !== "string"){
const err5 = {instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid7 = _errs45 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data16.schemaVersion !== undefined){
let data19 = data16.schemaVersion;
const _errs47 = errors;
if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){
const err6 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs47){
if((typeof data19 == "number") && (isFinite(data19))){
if(data19 > 4294967295 || isNaN(data19)){
const err7 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data19 < 1 || isNaN(data19)){
const err8 = {instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
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
var valid7 = _errs47 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
}
else {
const err9 = {instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
var _valid0 = _errs39 === errors;
valid5 = valid5 || _valid0;
const _errs49 = errors;
if(data16 !== null){
const err10 = {instancePath:instancePath+"/profile",schemaPath:"#/properties/profile/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var _valid0 = _errs49 === errors;
valid5 = valid5 || _valid0;
if(!valid5){
const err11 = {instancePath:instancePath+"/profile",schemaPath:"#/properties/profile/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
validate38.errors = vErrors;
return false;
}
else {
errors = _errs38;
if(vErrors !== null){
if(_errs38){
vErrors.length = _errs38;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs37 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.provider !== undefined){
const _errs51 = errors;
if(!(validate27(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate27.errors : vErrors.concat(validate27.errors);
errors = vErrors.length;
}
var valid0 = _errs51 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.resultId !== undefined){
const _errs52 = errors;
if(typeof data.resultId !== "string"){
validate38.errors = [{instancePath:instancePath+"/resultId",schemaPath:"#/properties/resultId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs52 === errors;
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
}
else {
validate38.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate38.errors = vErrors;
return errors === 0;
}
validate38.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema66 = {"description":"The context is the original outer invocation. Its inputDigest describes that\ninvocation, while input.sha256 independently authenticates the service bytes.","type":"object","properties":{"callId":{"type":"string"},"context":{"$ref":"#/$defs/InvocationContext"},"handleId":{"type":"string"},"input":{"$ref":"#/$defs/EncodedPayload"}},"additionalProperties":false,"required":["callId","handleId","context","input"]};

function validate46(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate46.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.callId === undefined) && (missing0 = "callId")) || ((data.handleId === undefined) && (missing0 = "handleId"))) || ((data.context === undefined) && (missing0 = "context"))) || ((data.input === undefined) && (missing0 = "input"))){
validate46.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "callId") || (key0 === "context")) || (key0 === "handleId")) || (key0 === "input"))){
validate46.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.callId !== undefined){
const _errs2 = errors;
if(typeof data.callId !== "string"){
validate46.errors = [{instancePath:instancePath+"/callId",schemaPath:"#/properties/callId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.context !== undefined){
let data1 = data.context;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if(((((((((((data1.projectId === undefined) && (missing1 = "projectId")) || ((data1.operationId === undefined) && (missing1 = "operationId"))) || ((data1.attemptId === undefined) && (missing1 = "attemptId"))) || ((data1.itemId === undefined) && (missing1 = "itemId"))) || ((data1.dispatchId === undefined) && (missing1 = "dispatchId"))) || ((data1.scopeId === undefined) && (missing1 = "scopeId"))) || ((data1.inputDigest === undefined) && (missing1 = "inputDigest"))) || ((data1.scopeDigest === undefined) && (missing1 = "scopeDigest"))) || ((data1.environmentDigest === undefined) && (missing1 = "environmentDigest"))) || ((data1.configurationDigest === undefined) && (missing1 = "configurationDigest"))){
validate46.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(func1.call(schema55.properties, key1))){
validate46.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.attemptId !== undefined){
const _errs8 = errors;
if(typeof data1.attemptId !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/attemptId",schemaPath:"#/$defs/InvocationContext/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.configurationDigest !== undefined){
const _errs10 = errors;
if(typeof data1.configurationDigest !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/configurationDigest",schemaPath:"#/$defs/InvocationContext/properties/configurationDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.dispatchId !== undefined){
const _errs12 = errors;
if(typeof data1.dispatchId !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/dispatchId",schemaPath:"#/$defs/InvocationContext/properties/dispatchId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.environmentDigest !== undefined){
const _errs14 = errors;
if(typeof data1.environmentDigest !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/environmentDigest",schemaPath:"#/$defs/InvocationContext/properties/environmentDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs14 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.inputDigest !== undefined){
const _errs16 = errors;
if(typeof data1.inputDigest !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/inputDigest",schemaPath:"#/$defs/InvocationContext/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs16 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.itemId !== undefined){
const _errs18 = errors;
if(typeof data1.itemId !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/itemId",schemaPath:"#/$defs/InvocationContext/properties/itemId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs18 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.operationId !== undefined){
const _errs20 = errors;
if(typeof data1.operationId !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/operationId",schemaPath:"#/$defs/InvocationContext/properties/operationId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs20 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.projectId !== undefined){
const _errs22 = errors;
if(typeof data1.projectId !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/projectId",schemaPath:"#/$defs/InvocationContext/properties/projectId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs22 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.scopeDigest !== undefined){
const _errs24 = errors;
if(typeof data1.scopeDigest !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/scopeDigest",schemaPath:"#/$defs/InvocationContext/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs24 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.scopeId !== undefined){
const _errs26 = errors;
if(typeof data1.scopeId !== "string"){
validate46.errors = [{instancePath:instancePath+"/context/scopeId",schemaPath:"#/$defs/InvocationContext/properties/scopeId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs26 === errors;
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
}
}
}
}
}
}
else {
validate46.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.handleId !== undefined){
const _errs28 = errors;
if(typeof data.handleId !== "string"){
validate46.errors = [{instancePath:instancePath+"/handleId",schemaPath:"#/properties/handleId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs28 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.input !== undefined){
const _errs30 = errors;
if(!(validate34(data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
errors = vErrors.length;
}
var valid0 = _errs30 === errors;
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
validate46.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate46.errors = vErrors;
return errors === 0;
}
validate46.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema68 = {"description":"A response preserves failed/unknown outcomes. Matching it does not authorize\na mutation, validate its domain payload or prove that a child task finished.","type":"object","properties":{"callId":{"type":"string"},"context":{"$ref":"#/$defs/InvocationContext"},"handleId":{"type":"string"},"outcome":{"$ref":"#/$defs/InvocationOutcome"}},"additionalProperties":false,"required":["callId","handleId","context","outcome"]};

function validate49(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate49.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.callId === undefined) && (missing0 = "callId")) || ((data.handleId === undefined) && (missing0 = "handleId"))) || ((data.context === undefined) && (missing0 = "context"))) || ((data.outcome === undefined) && (missing0 = "outcome"))){
validate49.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "callId") || (key0 === "context")) || (key0 === "handleId")) || (key0 === "outcome"))){
validate49.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.callId !== undefined){
const _errs2 = errors;
if(typeof data.callId !== "string"){
validate49.errors = [{instancePath:instancePath+"/callId",schemaPath:"#/properties/callId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.context !== undefined){
let data1 = data.context;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if(((((((((((data1.projectId === undefined) && (missing1 = "projectId")) || ((data1.operationId === undefined) && (missing1 = "operationId"))) || ((data1.attemptId === undefined) && (missing1 = "attemptId"))) || ((data1.itemId === undefined) && (missing1 = "itemId"))) || ((data1.dispatchId === undefined) && (missing1 = "dispatchId"))) || ((data1.scopeId === undefined) && (missing1 = "scopeId"))) || ((data1.inputDigest === undefined) && (missing1 = "inputDigest"))) || ((data1.scopeDigest === undefined) && (missing1 = "scopeDigest"))) || ((data1.environmentDigest === undefined) && (missing1 = "environmentDigest"))) || ((data1.configurationDigest === undefined) && (missing1 = "configurationDigest"))){
validate49.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(func1.call(schema55.properties, key1))){
validate49.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.attemptId !== undefined){
const _errs8 = errors;
if(typeof data1.attemptId !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/attemptId",schemaPath:"#/$defs/InvocationContext/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.configurationDigest !== undefined){
const _errs10 = errors;
if(typeof data1.configurationDigest !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/configurationDigest",schemaPath:"#/$defs/InvocationContext/properties/configurationDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.dispatchId !== undefined){
const _errs12 = errors;
if(typeof data1.dispatchId !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/dispatchId",schemaPath:"#/$defs/InvocationContext/properties/dispatchId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.environmentDigest !== undefined){
const _errs14 = errors;
if(typeof data1.environmentDigest !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/environmentDigest",schemaPath:"#/$defs/InvocationContext/properties/environmentDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs14 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.inputDigest !== undefined){
const _errs16 = errors;
if(typeof data1.inputDigest !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/inputDigest",schemaPath:"#/$defs/InvocationContext/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs16 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.itemId !== undefined){
const _errs18 = errors;
if(typeof data1.itemId !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/itemId",schemaPath:"#/$defs/InvocationContext/properties/itemId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs18 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.operationId !== undefined){
const _errs20 = errors;
if(typeof data1.operationId !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/operationId",schemaPath:"#/$defs/InvocationContext/properties/operationId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs20 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.projectId !== undefined){
const _errs22 = errors;
if(typeof data1.projectId !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/projectId",schemaPath:"#/$defs/InvocationContext/properties/projectId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs22 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.scopeDigest !== undefined){
const _errs24 = errors;
if(typeof data1.scopeDigest !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/scopeDigest",schemaPath:"#/$defs/InvocationContext/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs24 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.scopeId !== undefined){
const _errs26 = errors;
if(typeof data1.scopeId !== "string"){
validate49.errors = [{instancePath:instancePath+"/context/scopeId",schemaPath:"#/$defs/InvocationContext/properties/scopeId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs26 === errors;
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
}
}
}
}
}
}
else {
validate49.errors = [{instancePath:instancePath+"/context",schemaPath:"#/$defs/InvocationContext/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.handleId !== undefined){
const _errs28 = errors;
if(typeof data.handleId !== "string"){
validate49.errors = [{instancePath:instancePath+"/handleId",schemaPath:"#/properties/handleId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs28 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outcome !== undefined){
const _errs30 = errors;
if(!(validate39(data.outcome, {instancePath:instancePath+"/outcome",parentData:data,parentDataProperty:"outcome",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate39.errors : vErrors.concat(validate39.errors);
errors = vErrors.length;
}
var valid0 = _errs30 === errors;
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
validate49.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate49.errors = vErrors;
return errors === 0;
}
validate49.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


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
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.data === undefined) && (missing0 = "data"))){
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
if(!((key0 === "data") || (key0 === "kind"))){
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
if(data.data !== undefined){
const _errs4 = errors;
if(!(validate22(data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.kind !== undefined){
let data1 = data.kind;
const _errs5 = errors;
if(typeof data1 !== "string"){
const err2 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("activate" !== data1){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "activate"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid1 = _errs5 === errors;
}
else {
var valid1 = true;
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
const _errs7 = errors;
if(errors === _errs7){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if(((data.kind === undefined) && (missing1 = "kind")) || ((data.data === undefined) && (missing1 = "data"))){
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
const _errs9 = errors;
for(const key1 in data){
if(!((key1 === "data") || (key1 === "kind"))){
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
if(_errs9 === errors){
if(data.data !== undefined){
const _errs10 = errors;
if(!(validate22(data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
errors = vErrors.length;
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.kind !== undefined){
let data3 = data.kind;
const _errs11 = errors;
if(typeof data3 !== "string"){
const err7 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
if("ready" !== data3){
const err8 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "ready"},message:"must be equal to constant"};
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
}
}
}
}
else {
const err9 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
}
var _valid0 = _errs7 === errors;
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
const _errs13 = errors;
if(errors === _errs13){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if(((data.kind === undefined) && (missing2 = "kind")) || ((data.data === undefined) && (missing2 = "data"))){
const err10 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
else {
const _errs15 = errors;
for(const key2 in data){
if(!((key2 === "data") || (key2 === "kind"))){
const err11 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
break;
}
}
if(_errs15 === errors){
if(data.data !== undefined){
const _errs16 = errors;
if(!(validate33(data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate33.errors : vErrors.concat(validate33.errors);
errors = vErrors.length;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs17 = errors;
if(typeof data5 !== "string"){
const err12 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
if("invoke" !== data5){
const err13 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "invoke"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
var valid3 = _errs17 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
const err14 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
var _valid0 = _errs13 === errors;
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
const _errs19 = errors;
if(errors === _errs19){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing3;
if(((data.kind === undefined) && (missing3 = "kind")) || ((data.data === undefined) && (missing3 = "data"))){
const err15 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
const _errs21 = errors;
for(const key3 in data){
if(!((key3 === "data") || (key3 === "kind"))){
const err16 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
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
if(_errs21 === errors){
if(data.data !== undefined){
const _errs22 = errors;
if(!(validate38(data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate38.errors : vErrors.concat(validate38.errors);
errors = vErrors.length;
}
var valid4 = _errs22 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.kind !== undefined){
let data7 = data.kind;
const _errs23 = errors;
if(typeof data7 !== "string"){
const err17 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if("result" !== data7){
const err18 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "result"},message:"must be equal to constant"};
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
}
}
}
}
else {
const err19 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
var _valid0 = _errs19 === errors;
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
const _errs25 = errors;
if(errors === _errs25){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if(((data.kind === undefined) && (missing4 = "kind")) || ((data.data === undefined) && (missing4 = "data"))){
const err20 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
else {
const _errs27 = errors;
for(const key4 in data){
if(!((key4 === "data") || (key4 === "kind"))){
const err21 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
break;
}
}
if(_errs27 === errors){
if(data.data !== undefined){
const _errs28 = errors;
if(!(validate46(data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate46.errors : vErrors.concat(validate46.errors);
errors = vErrors.length;
}
var valid5 = _errs28 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data.kind !== undefined){
let data9 = data.kind;
const _errs29 = errors;
if(typeof data9 !== "string"){
const err22 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
if("service-request" !== data9){
const err23 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "service-request"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
var valid5 = _errs29 === errors;
}
else {
var valid5 = true;
}
}
}
}
}
else {
const err24 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
}
var _valid0 = _errs25 === errors;
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
const _errs31 = errors;
if(errors === _errs31){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if(((data.kind === undefined) && (missing5 = "kind")) || ((data.data === undefined) && (missing5 = "data"))){
const err25 = {instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
else {
const _errs33 = errors;
for(const key5 in data){
if(!((key5 === "data") || (key5 === "kind"))){
const err26 = {instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
break;
}
}
if(_errs33 === errors){
if(data.data !== undefined){
const _errs34 = errors;
if(!(validate49(data.data, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate49.errors : vErrors.concat(validate49.errors);
errors = vErrors.length;
}
var valid6 = _errs34 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data.kind !== undefined){
let data11 = data.kind;
const _errs35 = errors;
if(typeof data11 !== "string"){
const err27 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
}
if("service-response" !== data11){
const err28 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "service-response"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
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
else {
const err29 = {instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
}
var _valid0 = _errs31 === errors;
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
const _errs37 = errors;
if(errors === _errs37){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing6;
if(((data.kind === undefined) && (missing6 = "kind")) || ((data.data === undefined) && (missing6 = "data"))){
const err30 = {instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6},message:"must have required property '"+missing6+"'"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
else {
const _errs39 = errors;
for(const key6 in data){
if(!((key6 === "data") || (key6 === "kind"))){
const err31 = {instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
break;
}
}
if(_errs39 === errors){
if(data.data !== undefined){
let data12 = data.data;
const _errs40 = errors;
if(errors === _errs40){
if(data12 && typeof data12 == "object" && !Array.isArray(data12)){
let missing7;
if((data12.dispatchId === undefined) && (missing7 = "dispatchId")){
const err32 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/6/properties/data/required",keyword:"required",params:{missingProperty: missing7},message:"must have required property '"+missing7+"'"};
if(vErrors === null){
vErrors = [err32];
}
else {
vErrors.push(err32);
}
errors++;
}
else {
const _errs42 = errors;
for(const key7 in data12){
if(!(key7 === "dispatchId")){
const err33 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/6/properties/data/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7},message:"must NOT have additional properties"};
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
if(_errs42 === errors){
if(data12.dispatchId !== undefined){
if(typeof data12.dispatchId !== "string"){
const err34 = {instancePath:instancePath+"/data/dispatchId",schemaPath:"#/oneOf/6/properties/data/properties/dispatchId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err34];
}
else {
vErrors.push(err34);
}
errors++;
}
}
}
}
}
else {
const err35 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/6/properties/data/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err35];
}
else {
vErrors.push(err35);
}
errors++;
}
}
var valid7 = _errs40 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data.kind !== undefined){
let data14 = data.kind;
const _errs45 = errors;
if(typeof data14 !== "string"){
const err36 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err36];
}
else {
vErrors.push(err36);
}
errors++;
}
if("cancel" !== data14){
const err37 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "cancel"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err37];
}
else {
vErrors.push(err37);
}
errors++;
}
var valid7 = _errs45 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
else {
const err38 = {instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err38];
}
else {
vErrors.push(err38);
}
errors++;
}
}
var _valid0 = _errs37 === errors;
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
const _errs47 = errors;
if(errors === _errs47){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing8;
if(((data.kind === undefined) && (missing8 = "kind")) || ((data.data === undefined) && (missing8 = "data"))){
const err39 = {instancePath,schemaPath:"#/oneOf/7/required",keyword:"required",params:{missingProperty: missing8},message:"must have required property '"+missing8+"'"};
if(vErrors === null){
vErrors = [err39];
}
else {
vErrors.push(err39);
}
errors++;
}
else {
const _errs49 = errors;
for(const key8 in data){
if(!((key8 === "data") || (key8 === "kind"))){
const err40 = {instancePath,schemaPath:"#/oneOf/7/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err40];
}
else {
vErrors.push(err40);
}
errors++;
break;
}
}
if(_errs49 === errors){
if(data.data !== undefined){
let data15 = data.data;
const _errs50 = errors;
if(errors === _errs50){
if(data15 && typeof data15 == "object" && !Array.isArray(data15)){
let missing9;
if((data15.dispatchId === undefined) && (missing9 = "dispatchId")){
const err41 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/7/properties/data/required",keyword:"required",params:{missingProperty: missing9},message:"must have required property '"+missing9+"'"};
if(vErrors === null){
vErrors = [err41];
}
else {
vErrors.push(err41);
}
errors++;
}
else {
const _errs52 = errors;
for(const key9 in data15){
if(!(key9 === "dispatchId")){
const err42 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/7/properties/data/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err42];
}
else {
vErrors.push(err42);
}
errors++;
break;
}
}
if(_errs52 === errors){
if(data15.dispatchId !== undefined){
if(typeof data15.dispatchId !== "string"){
const err43 = {instancePath:instancePath+"/data/dispatchId",schemaPath:"#/oneOf/7/properties/data/properties/dispatchId/type",keyword:"type",params:{type: "string"},message:"must be string"};
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
}
else {
const err44 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/7/properties/data/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err44];
}
else {
vErrors.push(err44);
}
errors++;
}
}
var valid9 = _errs50 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data.kind !== undefined){
let data17 = data.kind;
const _errs55 = errors;
if(typeof data17 !== "string"){
const err45 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err45];
}
else {
vErrors.push(err45);
}
errors++;
}
if("cancelled" !== data17){
const err46 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/7/properties/kind/const",keyword:"const",params:{allowedValue: "cancelled"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err46];
}
else {
vErrors.push(err46);
}
errors++;
}
var valid9 = _errs55 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
else {
const err47 = {instancePath,schemaPath:"#/oneOf/7/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err47];
}
else {
vErrors.push(err47);
}
errors++;
}
}
var _valid0 = _errs47 === errors;
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
const _errs57 = errors;
if(errors === _errs57){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing10;
if(((data.kind === undefined) && (missing10 = "kind")) || ((data.data === undefined) && (missing10 = "data"))){
const err48 = {instancePath,schemaPath:"#/oneOf/8/required",keyword:"required",params:{missingProperty: missing10},message:"must have required property '"+missing10+"'"};
if(vErrors === null){
vErrors = [err48];
}
else {
vErrors.push(err48);
}
errors++;
}
else {
const _errs59 = errors;
for(const key10 in data){
if(!((key10 === "data") || (key10 === "kind"))){
const err49 = {instancePath,schemaPath:"#/oneOf/8/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key10},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err49];
}
else {
vErrors.push(err49);
}
errors++;
break;
}
}
if(_errs59 === errors){
if(data.data !== undefined){
let data18 = data.data;
const _errs60 = errors;
if(errors === _errs60){
if(data18 && typeof data18 == "object" && !Array.isArray(data18)){
let missing11;
if((data18.provider === undefined) && (missing11 = "provider")){
const err50 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/8/properties/data/required",keyword:"required",params:{missingProperty: missing11},message:"must have required property '"+missing11+"'"};
if(vErrors === null){
vErrors = [err50];
}
else {
vErrors.push(err50);
}
errors++;
}
else {
const _errs62 = errors;
for(const key11 in data18){
if(!(key11 === "provider")){
const err51 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/8/properties/data/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key11},message:"must NOT have additional properties"};
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
if(_errs62 === errors){
if(data18.provider !== undefined){
if(!(validate27(data18.provider, {instancePath:instancePath+"/data/provider",parentData:data18,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate27.errors : vErrors.concat(validate27.errors);
errors = vErrors.length;
}
}
}
}
}
else {
const err52 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/8/properties/data/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err52];
}
else {
vErrors.push(err52);
}
errors++;
}
}
var valid11 = _errs60 === errors;
}
else {
var valid11 = true;
}
if(valid11){
if(data.kind !== undefined){
let data20 = data.kind;
const _errs64 = errors;
if(typeof data20 !== "string"){
const err53 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/8/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err53];
}
else {
vErrors.push(err53);
}
errors++;
}
if("close" !== data20){
const err54 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/8/properties/kind/const",keyword:"const",params:{allowedValue: "close"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err54];
}
else {
vErrors.push(err54);
}
errors++;
}
var valid11 = _errs64 === errors;
}
else {
var valid11 = true;
}
}
}
}
}
else {
const err55 = {instancePath,schemaPath:"#/oneOf/8/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err55];
}
else {
vErrors.push(err55);
}
errors++;
}
}
var _valid0 = _errs57 === errors;
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
const _errs66 = errors;
if(errors === _errs66){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing12;
if(((data.kind === undefined) && (missing12 = "kind")) || ((data.data === undefined) && (missing12 = "data"))){
const err56 = {instancePath,schemaPath:"#/oneOf/9/required",keyword:"required",params:{missingProperty: missing12},message:"must have required property '"+missing12+"'"};
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
for(const key12 in data){
if(!((key12 === "data") || (key12 === "kind"))){
const err57 = {instancePath,schemaPath:"#/oneOf/9/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key12},message:"must NOT have additional properties"};
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
if(data.data !== undefined){
let data21 = data.data;
const _errs69 = errors;
if(errors === _errs69){
if(data21 && typeof data21 == "object" && !Array.isArray(data21)){
let missing13;
if((data21.provider === undefined) && (missing13 = "provider")){
const err58 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/9/properties/data/required",keyword:"required",params:{missingProperty: missing13},message:"must have required property '"+missing13+"'"};
if(vErrors === null){
vErrors = [err58];
}
else {
vErrors.push(err58);
}
errors++;
}
else {
const _errs71 = errors;
for(const key13 in data21){
if(!(key13 === "provider")){
const err59 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/9/properties/data/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key13},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err59];
}
else {
vErrors.push(err59);
}
errors++;
break;
}
}
if(_errs71 === errors){
if(data21.provider !== undefined){
if(!(validate27(data21.provider, {instancePath:instancePath+"/data/provider",parentData:data21,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate27.errors : vErrors.concat(validate27.errors);
errors = vErrors.length;
}
}
}
}
}
else {
const err60 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/9/properties/data/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err60];
}
else {
vErrors.push(err60);
}
errors++;
}
}
var valid13 = _errs69 === errors;
}
else {
var valid13 = true;
}
if(valid13){
if(data.kind !== undefined){
let data23 = data.kind;
const _errs73 = errors;
if(typeof data23 !== "string"){
const err61 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/9/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err61];
}
else {
vErrors.push(err61);
}
errors++;
}
if("closed" !== data23){
const err62 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/9/properties/kind/const",keyword:"const",params:{allowedValue: "closed"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err62];
}
else {
vErrors.push(err62);
}
errors++;
}
var valid13 = _errs73 === errors;
}
else {
var valid13 = true;
}
}
}
}
}
else {
const err63 = {instancePath,schemaPath:"#/oneOf/9/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err63];
}
else {
vErrors.push(err63);
}
errors++;
}
}
var _valid0 = _errs66 === errors;
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
const _errs75 = errors;
if(errors === _errs75){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing14;
if(((data.kind === undefined) && (missing14 = "kind")) || ((data.data === undefined) && (missing14 = "data"))){
const err64 = {instancePath,schemaPath:"#/oneOf/10/required",keyword:"required",params:{missingProperty: missing14},message:"must have required property '"+missing14+"'"};
if(vErrors === null){
vErrors = [err64];
}
else {
vErrors.push(err64);
}
errors++;
}
else {
const _errs77 = errors;
for(const key14 in data){
if(!((key14 === "data") || (key14 === "kind"))){
const err65 = {instancePath,schemaPath:"#/oneOf/10/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key14},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err65];
}
else {
vErrors.push(err65);
}
errors++;
break;
}
}
if(_errs77 === errors){
if(data.data !== undefined){
let data24 = data.data;
const _errs78 = errors;
if(errors === _errs78){
if(data24 && typeof data24 == "object" && !Array.isArray(data24)){
let missing15;
if((data24.nonce === undefined) && (missing15 = "nonce")){
const err66 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/10/properties/data/required",keyword:"required",params:{missingProperty: missing15},message:"must have required property '"+missing15+"'"};
if(vErrors === null){
vErrors = [err66];
}
else {
vErrors.push(err66);
}
errors++;
}
else {
const _errs80 = errors;
for(const key15 in data24){
if(!(key15 === "nonce")){
const err67 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/10/properties/data/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key15},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err67];
}
else {
vErrors.push(err67);
}
errors++;
break;
}
}
if(_errs80 === errors){
if(data24.nonce !== undefined){
if(typeof data24.nonce !== "string"){
const err68 = {instancePath:instancePath+"/data/nonce",schemaPath:"#/oneOf/10/properties/data/properties/nonce/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err68];
}
else {
vErrors.push(err68);
}
errors++;
}
}
}
}
}
else {
const err69 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/10/properties/data/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err69];
}
else {
vErrors.push(err69);
}
errors++;
}
}
var valid15 = _errs78 === errors;
}
else {
var valid15 = true;
}
if(valid15){
if(data.kind !== undefined){
let data26 = data.kind;
const _errs83 = errors;
if(typeof data26 !== "string"){
const err70 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/10/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err70];
}
else {
vErrors.push(err70);
}
errors++;
}
if("ping" !== data26){
const err71 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/10/properties/kind/const",keyword:"const",params:{allowedValue: "ping"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err71];
}
else {
vErrors.push(err71);
}
errors++;
}
var valid15 = _errs83 === errors;
}
else {
var valid15 = true;
}
}
}
}
}
else {
const err72 = {instancePath,schemaPath:"#/oneOf/10/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err72];
}
else {
vErrors.push(err72);
}
errors++;
}
}
var _valid0 = _errs75 === errors;
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
const _errs85 = errors;
if(errors === _errs85){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing16;
if(((data.kind === undefined) && (missing16 = "kind")) || ((data.data === undefined) && (missing16 = "data"))){
const err73 = {instancePath,schemaPath:"#/oneOf/11/required",keyword:"required",params:{missingProperty: missing16},message:"must have required property '"+missing16+"'"};
if(vErrors === null){
vErrors = [err73];
}
else {
vErrors.push(err73);
}
errors++;
}
else {
const _errs87 = errors;
for(const key16 in data){
if(!((key16 === "data") || (key16 === "kind"))){
const err74 = {instancePath,schemaPath:"#/oneOf/11/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key16},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err74];
}
else {
vErrors.push(err74);
}
errors++;
break;
}
}
if(_errs87 === errors){
if(data.data !== undefined){
let data27 = data.data;
const _errs88 = errors;
if(errors === _errs88){
if(data27 && typeof data27 == "object" && !Array.isArray(data27)){
let missing17;
if((data27.nonce === undefined) && (missing17 = "nonce")){
const err75 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/11/properties/data/required",keyword:"required",params:{missingProperty: missing17},message:"must have required property '"+missing17+"'"};
if(vErrors === null){
vErrors = [err75];
}
else {
vErrors.push(err75);
}
errors++;
}
else {
const _errs90 = errors;
for(const key17 in data27){
if(!(key17 === "nonce")){
const err76 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/11/properties/data/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key17},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err76];
}
else {
vErrors.push(err76);
}
errors++;
break;
}
}
if(_errs90 === errors){
if(data27.nonce !== undefined){
if(typeof data27.nonce !== "string"){
const err77 = {instancePath:instancePath+"/data/nonce",schemaPath:"#/oneOf/11/properties/data/properties/nonce/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err77];
}
else {
vErrors.push(err77);
}
errors++;
}
}
}
}
}
else {
const err78 = {instancePath:instancePath+"/data",schemaPath:"#/oneOf/11/properties/data/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err78];
}
else {
vErrors.push(err78);
}
errors++;
}
}
var valid17 = _errs88 === errors;
}
else {
var valid17 = true;
}
if(valid17){
if(data.kind !== undefined){
let data29 = data.kind;
const _errs93 = errors;
if(typeof data29 !== "string"){
const err79 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/11/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err79];
}
else {
vErrors.push(err79);
}
errors++;
}
if("pong" !== data29){
const err80 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/11/properties/kind/const",keyword:"const",params:{allowedValue: "pong"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err80];
}
else {
vErrors.push(err80);
}
errors++;
}
var valid17 = _errs93 === errors;
}
else {
var valid17 = true;
}
}
}
}
}
else {
const err81 = {instancePath,schemaPath:"#/oneOf/11/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err81];
}
else {
vErrors.push(err81);
}
errors++;
}
}
var _valid0 = _errs85 === errors;
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
const err82 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err82];
}
else {
vErrors.push(err82);
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
if(((data.protocolVersion === undefined) && (missing0 = "protocolVersion")) || ((data.body === undefined) && (missing0 = "body"))){
validate20.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "body") || (key0 === "protocolVersion"))){
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
if(2 !== data1){
validate20.errors = [{instancePath:instancePath+"/protocolVersion",schemaPath:"#/properties/protocolVersion/const",keyword:"const",params:{allowedValue: 2},message:"must be equal to constant"}];
return false;
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
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
