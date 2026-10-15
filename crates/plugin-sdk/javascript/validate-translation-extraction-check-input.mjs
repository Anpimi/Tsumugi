// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.
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
export const validate = validate172;
export default validate172;
const schema189 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TranslationExtractionCheckInput","type":"object","properties":{"input":{"$ref":"#/$defs/TranslationExtractionInput"},"proposal":{"$ref":"#/$defs/TranslationExchange"},"requirements":{"type":"array","items":{"$ref":"#/$defs/CheckRequirement"}}},"additionalProperties":false,"required":["input","proposal","requirements"],"$defs":{"CapturedTextArtifact":{"description":"Captured UTF-8 bytes, including a BOM and original line endings. These are\nimmutable source evidence; logical paths are not local filesystem authority.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]},"CheckImplementation":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]},"CheckKey":{"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]},"CheckRequirement":{"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"ImportedTranslation":{"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"$ref":"#/$defs/NativeIdentityEvidence"},"source":{"$ref":"#/$defs/SourceReference"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","text","source","nativeIdentity"]},"NativeIdentityDisplay":{"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]},"NativeIdentityEvidence":{"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]},"NotApplicableBasis":{"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]},"PluginIdentity":{"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]},"ProviderSelectionBinding":{"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["artifactId","range"]},"TextEncoding":{"type":"string","enum":["utf8-byte","utf16","grapheme"]},"TextRange":{"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"TranslationExchange":{"description":"Complete captured file evidence is retained once, including an empty file.\nDeclared language is domain evidence, not an inferred project locale.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedTextArtifact"}},"declaredLanguage":{"type":"string"},"entries":{"type":"array","items":{"$ref":"#/$defs/ImportedTranslation"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"order":{"type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","declaredLanguage","languageEvidence","nativeScope","artifacts","entries","order"]},"TranslationExtractionInput":{"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedTextArtifact"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","languageEvidence","nativeScope","artifacts"]},"TranslationLanguageEvidence":{"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]},"TranslationNativeScope":{"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]}}};
const schema190 = {"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedTextArtifact"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","languageEvidence","nativeScope","artifacts"]};
const schema191 = {"description":"Captured UTF-8 bytes, including a BOM and original line endings. These are\nimmutable source evidence; logical paths are not local filesystem authority.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]};
const schema192 = {"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]};
const schema194 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema193 = {"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]};

function validate174(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate174.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.namespace === undefined) && (missing0 = "namespace")) || ((data.policy === undefined) && (missing0 = "policy"))){
validate174.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "namespace") || (key0 === "policy"))){
validate174.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.namespace !== undefined){
const _errs2 = errors;
if(typeof data.namespace !== "string"){
validate174.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.policy !== undefined){
let data1 = data.policy;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate174.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate174.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate174.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate174.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate174.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.id !== undefined){
const _errs10 = errors;
if(typeof data1.id !== "string"){
validate174.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs12 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate174.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate174.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate174.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs12 === errors;
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
validate174.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate174.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate174.errors = vErrors;
return errors === 0;
}
validate174.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate173(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate173.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((((data.profile === undefined) && (missing0 = "profile")) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.sourceSnapshotId === undefined) && (missing0 = "sourceSnapshotId"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.languageEvidence === undefined) && (missing0 = "languageEvidence"))) || ((data.nativeScope === undefined) && (missing0 = "nativeScope"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))){
validate173.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "artifacts") || (key0 === "importId")) || (key0 === "languageEvidence")) || (key0 === "nativeScope")) || (key0 === "profile")) || (key0 === "sourceSetId")) || (key0 === "sourceSnapshotId")) || (key0 === "targetLanguage"))){
validate173.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifacts !== undefined){
let data0 = data.artifacts;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
let data1 = data0[i0];
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((((data1.id === undefined) && (missing1 = "id")) || ((data1.logicalPath === undefined) && (missing1 = "logicalPath"))) || ((data1.role === undefined) && (missing1 = "role"))) || ((data1.sha256 === undefined) && (missing1 = "sha256"))) || ((data1.utf8 === undefined) && (missing1 = "utf8"))){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((((key1 === "id") || (key1 === "logicalPath")) || (key1 === "role")) || (key1 === "sha256")) || (key1 === "utf8"))){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.id !== undefined){
const _errs8 = errors;
if(typeof data1.id !== "string"){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/id",schemaPath:"#/$defs/CapturedTextArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs8 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.logicalPath !== undefined){
const _errs10 = errors;
if(typeof data1.logicalPath !== "string"){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/logicalPath",schemaPath:"#/$defs/CapturedTextArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs10 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.role !== undefined){
const _errs12 = errors;
if(typeof data1.role !== "string"){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/role",schemaPath:"#/$defs/CapturedTextArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.sha256 !== undefined){
const _errs14 = errors;
if(typeof data1.sha256 !== "string"){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/sha256",schemaPath:"#/$defs/CapturedTextArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.utf8 !== undefined){
const _errs16 = errors;
if(typeof data1.utf8 !== "string"){
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/utf8",schemaPath:"#/$defs/CapturedTextArtifact/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
}
}
else {
validate173.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate173.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.importId !== undefined){
const _errs18 = errors;
if(typeof data.importId !== "string"){
validate173.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/properties/importId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs18 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.languageEvidence !== undefined){
let data8 = data.languageEvidence;
const _errs20 = errors;
if(typeof data8 !== "string"){
validate173.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(data8 === "user-confirmed")){
validate173.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/enum",keyword:"enum",params:{allowedValues: schema192.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs20 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeScope !== undefined){
const _errs23 = errors;
if(!(validate174(data.nativeScope, {instancePath:instancePath+"/nativeScope",parentData:data,parentDataProperty:"nativeScope",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate174.errors : vErrors.concat(validate174.errors);
errors = vErrors.length;
}
var valid0 = _errs23 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data10 = data.profile;
const _errs24 = errors;
const _errs25 = errors;
if(errors === _errs25){
if(data10 && typeof data10 == "object" && !Array.isArray(data10)){
let missing2;
if((((data10.id === undefined) && (missing2 = "id")) || ((data10.schemaVersion === undefined) && (missing2 = "schemaVersion"))) || ((data10.behaviorVersion === undefined) && (missing2 = "behaviorVersion"))){
validate173.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs27 = errors;
for(const key2 in data10){
if(!(((key2 === "behaviorVersion") || (key2 === "id")) || (key2 === "schemaVersion"))){
validate173.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs27 === errors){
if(data10.behaviorVersion !== undefined){
let data11 = data10.behaviorVersion;
const _errs28 = errors;
if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){
validate173.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs28){
if((typeof data11 == "number") && (isFinite(data11))){
if(data11 > 4294967295 || isNaN(data11)){
validate173.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data11 < 1 || isNaN(data11)){
validate173.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid6 = _errs28 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data10.id !== undefined){
const _errs30 = errors;
if(typeof data10.id !== "string"){
validate173.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid6 = _errs30 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data10.schemaVersion !== undefined){
let data13 = data10.schemaVersion;
const _errs32 = errors;
if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){
validate173.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs32){
if((typeof data13 == "number") && (isFinite(data13))){
if(data13 > 4294967295 || isNaN(data13)){
validate173.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data13 < 1 || isNaN(data13)){
validate173.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid6 = _errs32 === errors;
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
validate173.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs24 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs34 = errors;
if(typeof data.sourceSetId !== "string"){
validate173.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs34 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSnapshotId !== undefined){
const _errs36 = errors;
if(typeof data.sourceSnapshotId !== "string"){
validate173.errors = [{instancePath:instancePath+"/sourceSnapshotId",schemaPath:"#/properties/sourceSnapshotId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs36 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs38 = errors;
if(typeof data.targetLanguage !== "string"){
validate173.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs38 === errors;
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
validate173.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate173.errors = vErrors;
return errors === 0;
}
validate173.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema196 = {"description":"Complete captured file evidence is retained once, including an empty file.\nDeclared language is domain evidence, not an inferred project locale.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedTextArtifact"}},"declaredLanguage":{"type":"string"},"entries":{"type":"array","items":{"$ref":"#/$defs/ImportedTranslation"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"order":{"type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","declaredLanguage","languageEvidence","nativeScope","artifacts","entries","order"]};
const func1 = Object.prototype.hasOwnProperty;
const schema198 = {"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"$ref":"#/$defs/NativeIdentityEvidence"},"source":{"$ref":"#/$defs/SourceReference"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","text","source","nativeIdentity"]};
const schema199 = {"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]};
const schema200 = {"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]};
const schema201 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema202 = {"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema203 = {"type":"string","enum":["utf8-byte","utf16","grapheme"]};

function validate182(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate182.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.encoding === undefined) && (missing0 = "encoding")) || ((data.start === undefined) && (missing0 = "start"))) || ((data.end === undefined) && (missing0 = "end"))){
validate182.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate182.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate182.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme"))){
validate182.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/enum",keyword:"enum",params:{allowedValues: schema203.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.end !== undefined){
let data1 = data.end;
const _errs5 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate182.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate182.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate182.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
if(data.start !== undefined){
let data2 = data.start;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate182.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate182.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate182.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
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
else {
validate182.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate182.errors = vErrors;
return errors === 0;
}
validate182.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate181(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate181.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.range === undefined) && (missing0 = "range"))){
validate181.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate181.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate181.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.range !== undefined){
const _errs4 = errors;
if(!(validate182(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate182.errors : vErrors.concat(validate182.errors);
errors = vErrors.length;
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
validate181.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate181.errors = vErrors;
return errors === 0;
}
validate181.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate180(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate180.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.value === undefined) && (missing0 = "value")) || ((data.source === undefined) && (missing0 = "source"))){
validate180.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "source") || (key0 === "value"))){
validate180.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.source !== undefined){
let data0 = data.source;
const _errs2 = errors;
const _errs3 = errors;
let valid1 = false;
const _errs4 = errors;
if(!(validate181(data0, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate181.errors : vErrors.concat(validate181.errors);
errors = vErrors.length;
}
var _valid0 = _errs4 === errors;
valid1 = valid1 || _valid0;
const _errs5 = errors;
if(data0 !== null){
const err0 = {instancePath:instancePath+"/source",schemaPath:"#/properties/source/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs5 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err1 = {instancePath:instancePath+"/source",schemaPath:"#/properties/source/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
validate180.errors = vErrors;
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
if(data.value !== undefined){
const _errs7 = errors;
if(typeof data.value !== "string"){
validate180.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
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
else {
validate180.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate180.errors = vErrors;
return errors === 0;
}
validate180.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate179(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate179.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.namespace === undefined) && (missing0 = "namespace")) || ((data.value === undefined) && (missing0 = "value"))) || ((data.policy === undefined) && (missing0 = "policy"))) || ((data.display === undefined) && (missing0 = "display"))){
validate179.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "display") || (key0 === "namespace")) || (key0 === "policy")) || (key0 === "value"))){
validate179.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.display !== undefined){
const _errs2 = errors;
if(!(validate180(data.display, {instancePath:instancePath+"/display",parentData:data,parentDataProperty:"display",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate180.errors : vErrors.concat(validate180.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.namespace !== undefined){
const _errs3 = errors;
if(typeof data.namespace !== "string"){
validate179.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.policy !== undefined){
let data2 = data.policy;
const _errs5 = errors;
const _errs6 = errors;
if(errors === _errs6){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing1;
if((((data2.id === undefined) && (missing1 = "id")) || ((data2.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data2.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate179.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate179.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate179.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate179.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate179.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data2.id !== undefined){
const _errs11 = errors;
if(typeof data2.id !== "string"){
validate179.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs11 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data2.schemaVersion !== undefined){
let data5 = data2.schemaVersion;
const _errs13 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
validate179.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs13){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate179.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate179.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs13 === errors;
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
validate179.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.value !== undefined){
const _errs15 = errors;
if(typeof data.value !== "string"){
validate179.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate179.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate179.errors = vErrors;
return errors === 0;
}
validate179.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate178(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate178.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.id === undefined) && (missing0 = "id")) || ((data.text === undefined) && (missing0 = "text"))) || ((data.source === undefined) && (missing0 = "source"))) || ((data.nativeIdentity === undefined) && (missing0 = "nativeIdentity"))){
validate178.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "id") || (key0 === "nativeIdentity")) || (key0 === "source")) || (key0 === "text"))){
validate178.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate178.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeIdentity !== undefined){
const _errs4 = errors;
if(!(validate179(data.nativeIdentity, {instancePath:instancePath+"/nativeIdentity",parentData:data,parentDataProperty:"nativeIdentity",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate179.errors : vErrors.concat(validate179.errors);
errors = vErrors.length;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.source !== undefined){
const _errs5 = errors;
if(!(validate181(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate181.errors : vErrors.concat(validate181.errors);
errors = vErrors.length;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.text !== undefined){
const _errs6 = errors;
if(typeof data.text !== "string"){
validate178.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
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
validate178.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate178.errors = vErrors;
return errors === 0;
}
validate178.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate177(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate177.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((((((((data.profile === undefined) && (missing0 = "profile")) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.sourceSnapshotId === undefined) && (missing0 = "sourceSnapshotId"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.declaredLanguage === undefined) && (missing0 = "declaredLanguage"))) || ((data.languageEvidence === undefined) && (missing0 = "languageEvidence"))) || ((data.nativeScope === undefined) && (missing0 = "nativeScope"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))) || ((data.entries === undefined) && (missing0 = "entries"))) || ((data.order === undefined) && (missing0 = "order"))){
validate177.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(func1.call(schema196.properties, key0))){
validate177.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifacts !== undefined){
let data0 = data.artifacts;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
let data1 = data0[i0];
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((((data1.id === undefined) && (missing1 = "id")) || ((data1.logicalPath === undefined) && (missing1 = "logicalPath"))) || ((data1.role === undefined) && (missing1 = "role"))) || ((data1.sha256 === undefined) && (missing1 = "sha256"))) || ((data1.utf8 === undefined) && (missing1 = "utf8"))){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((((key1 === "id") || (key1 === "logicalPath")) || (key1 === "role")) || (key1 === "sha256")) || (key1 === "utf8"))){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.id !== undefined){
const _errs8 = errors;
if(typeof data1.id !== "string"){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/id",schemaPath:"#/$defs/CapturedTextArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs8 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.logicalPath !== undefined){
const _errs10 = errors;
if(typeof data1.logicalPath !== "string"){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/logicalPath",schemaPath:"#/$defs/CapturedTextArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs10 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.role !== undefined){
const _errs12 = errors;
if(typeof data1.role !== "string"){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/role",schemaPath:"#/$defs/CapturedTextArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.sha256 !== undefined){
const _errs14 = errors;
if(typeof data1.sha256 !== "string"){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/sha256",schemaPath:"#/$defs/CapturedTextArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.utf8 !== undefined){
const _errs16 = errors;
if(typeof data1.utf8 !== "string"){
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/utf8",schemaPath:"#/$defs/CapturedTextArtifact/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
}
}
else {
validate177.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate177.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.declaredLanguage !== undefined){
const _errs18 = errors;
if(typeof data.declaredLanguage !== "string"){
validate177.errors = [{instancePath:instancePath+"/declaredLanguage",schemaPath:"#/properties/declaredLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs18 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.entries !== undefined){
let data8 = data.entries;
const _errs20 = errors;
if(errors === _errs20){
if(Array.isArray(data8)){
var valid4 = true;
const len1 = data8.length;
for(let i1=0; i1<len1; i1++){
const _errs22 = errors;
if(!(validate178(data8[i1], {instancePath:instancePath+"/entries/" + i1,parentData:data8,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate178.errors : vErrors.concat(validate178.errors);
errors = vErrors.length;
}
var valid4 = _errs22 === errors;
if(!valid4){
break;
}
}
}
else {
validate177.errors = [{instancePath:instancePath+"/entries",schemaPath:"#/properties/entries/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs20 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.importId !== undefined){
const _errs23 = errors;
if(typeof data.importId !== "string"){
validate177.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/properties/importId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs23 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.languageEvidence !== undefined){
let data11 = data.languageEvidence;
const _errs25 = errors;
if(typeof data11 !== "string"){
validate177.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(data11 === "user-confirmed")){
validate177.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/enum",keyword:"enum",params:{allowedValues: schema192.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs25 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeScope !== undefined){
const _errs28 = errors;
if(!(validate174(data.nativeScope, {instancePath:instancePath+"/nativeScope",parentData:data,parentDataProperty:"nativeScope",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate174.errors : vErrors.concat(validate174.errors);
errors = vErrors.length;
}
var valid0 = _errs28 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.order !== undefined){
let data13 = data.order;
const _errs29 = errors;
if(errors === _errs29){
if(Array.isArray(data13)){
var valid6 = true;
const len2 = data13.length;
for(let i2=0; i2<len2; i2++){
const _errs31 = errors;
if(typeof data13[i2] !== "string"){
validate177.errors = [{instancePath:instancePath+"/order/" + i2,schemaPath:"#/properties/order/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid6 = _errs31 === errors;
if(!valid6){
break;
}
}
}
else {
validate177.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs29 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data15 = data.profile;
const _errs33 = errors;
const _errs34 = errors;
if(errors === _errs34){
if(data15 && typeof data15 == "object" && !Array.isArray(data15)){
let missing2;
if((((data15.id === undefined) && (missing2 = "id")) || ((data15.schemaVersion === undefined) && (missing2 = "schemaVersion"))) || ((data15.behaviorVersion === undefined) && (missing2 = "behaviorVersion"))){
validate177.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs36 = errors;
for(const key2 in data15){
if(!(((key2 === "behaviorVersion") || (key2 === "id")) || (key2 === "schemaVersion"))){
validate177.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs36 === errors){
if(data15.behaviorVersion !== undefined){
let data16 = data15.behaviorVersion;
const _errs37 = errors;
if(!(((typeof data16 == "number") && (!(data16 % 1) && !isNaN(data16))) && (isFinite(data16)))){
validate177.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs37){
if((typeof data16 == "number") && (isFinite(data16))){
if(data16 > 4294967295 || isNaN(data16)){
validate177.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data16 < 1 || isNaN(data16)){
validate177.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid8 = _errs37 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data15.id !== undefined){
const _errs39 = errors;
if(typeof data15.id !== "string"){
validate177.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid8 = _errs39 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data15.schemaVersion !== undefined){
let data18 = data15.schemaVersion;
const _errs41 = errors;
if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){
validate177.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs41){
if((typeof data18 == "number") && (isFinite(data18))){
if(data18 > 4294967295 || isNaN(data18)){
validate177.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data18 < 1 || isNaN(data18)){
validate177.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid8 = _errs41 === errors;
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
validate177.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs33 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs43 = errors;
if(typeof data.sourceSetId !== "string"){
validate177.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs43 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSnapshotId !== undefined){
const _errs45 = errors;
if(typeof data.sourceSnapshotId !== "string"){
validate177.errors = [{instancePath:instancePath+"/sourceSnapshotId",schemaPath:"#/properties/sourceSnapshotId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs45 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs47 = errors;
if(typeof data.targetLanguage !== "string"){
validate177.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs47 === errors;
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
else {
validate177.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate177.errors = vErrors;
return errors === 0;
}
validate177.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema207 = {"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]};
const schema214 = {"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]};
const schema208 = {"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]};
const schema209 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]};
const schema211 = {"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]};
const schema212 = {"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]};

function validate194(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate194.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.plugin === undefined) && (missing0 = "plugin")) || ((data.componentId === undefined) && (missing0 = "componentId"))) || ((data.contributionId === undefined) && (missing0 = "contributionId"))) || ((data.packageDigest === undefined) && (missing0 = "packageDigest"))){
validate194.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "componentId") || (key0 === "contributionId")) || (key0 === "packageDigest")) || (key0 === "plugin"))){
validate194.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.componentId !== undefined){
const _errs2 = errors;
if(typeof data.componentId !== "string"){
validate194.errors = [{instancePath:instancePath+"/componentId",schemaPath:"#/properties/componentId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.contributionId !== undefined){
const _errs4 = errors;
if(typeof data.contributionId !== "string"){
validate194.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.packageDigest !== undefined){
const _errs6 = errors;
if(typeof data.packageDigest !== "string"){
validate194.errors = [{instancePath:instancePath+"/packageDigest",schemaPath:"#/properties/packageDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.plugin !== undefined){
let data3 = data.plugin;
const _errs8 = errors;
const _errs9 = errors;
if(errors === _errs9){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing1;
if((((data3.publisher === undefined) && (missing1 = "publisher")) || ((data3.id === undefined) && (missing1 = "id"))) || ((data3.version === undefined) && (missing1 = "version"))){
validate194.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs11 = errors;
for(const key1 in data3){
if(!(((key1 === "id") || (key1 === "publisher")) || (key1 === "version"))){
validate194.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs11 === errors){
if(data3.id !== undefined){
const _errs12 = errors;
if(typeof data3.id !== "string"){
validate194.errors = [{instancePath:instancePath+"/plugin/id",schemaPath:"#/$defs/PluginIdentity/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data3.publisher !== undefined){
const _errs14 = errors;
if(typeof data3.publisher !== "string"){
validate194.errors = [{instancePath:instancePath+"/plugin/publisher",schemaPath:"#/$defs/PluginIdentity/properties/publisher/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs14 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data3.version !== undefined){
const _errs16 = errors;
if(typeof data3.version !== "string"){
validate194.errors = [{instancePath:instancePath+"/plugin/version",schemaPath:"#/$defs/PluginIdentity/properties/version/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs16 === errors;
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
validate194.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs8 === errors;
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
validate194.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate194.errors = vErrors;
return errors === 0;
}
validate194.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate193(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate193.evaluated;
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
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.validator === undefined) && (missing0 = "validator"))){
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
if(!((key0 === "kind") || (key0 === "validator"))){
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
if("core" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "core"},message:"must be equal to constant"};
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
if(data.validator !== undefined){
let data1 = data.validator;
const _errs6 = errors;
const _errs7 = errors;
if(errors === _errs7){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
const err4 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
else {
const _errs9 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
const err5 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
break;
}
}
if(_errs9 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs10 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
const err6 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs10){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
const err7 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data2 < 1 || isNaN(data2)){
const err8 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
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
var valid3 = _errs10 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.id !== undefined){
const _errs12 = errors;
if(typeof data1.id !== "string"){
const err9 = {instancePath:instancePath+"/validator/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs14 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
const err10 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(errors === _errs14){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
const err11 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
else {
if(data4 < 1 || isNaN(data4)){
const err12 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
}
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
else {
const err13 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
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
const err14 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
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
const _errs16 = errors;
if(errors === _errs16){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if(((data.kind === undefined) && (missing2 = "kind")) || ((data.provider === undefined) && (missing2 = "provider"))){
const err15 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
const _errs18 = errors;
for(const key2 in data){
if(!((key2 === "kind") || (key2 === "provider"))){
const err16 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
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
if(_errs18 === errors){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs19 = errors;
if(typeof data5 !== "string"){
const err17 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if("plugin" !== data5){
const err18 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "plugin"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.provider !== undefined){
const _errs21 = errors;
if(!(validate194(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate194.errors : vErrors.concat(validate194.errors);
errors = vErrors.length;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
else {
const err19 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
var _valid0 = _errs16 === errors;
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
}
if(!valid0){
const err20 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
validate193.errors = vErrors;
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
validate193.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate193.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate192(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate192.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.rule === undefined) && (missing0 = "rule")) || ((data.implementation === undefined) && (missing0 = "implementation"))){
validate192.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "implementation") || (key0 === "rule"))){
validate192.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.implementation !== undefined){
const _errs2 = errors;
if(!(validate193(data.implementation, {instancePath:instancePath+"/implementation",parentData:data,parentDataProperty:"implementation",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate193.errors : vErrors.concat(validate193.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.rule !== undefined){
let data1 = data.rule;
const _errs3 = errors;
const _errs4 = errors;
if(errors === _errs4){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate192.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs6 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate192.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs6 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate192.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate192.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate192.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs7 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.id !== undefined){
const _errs9 = errors;
if(typeof data1.id !== "string"){
validate192.errors = [{instancePath:instancePath+"/rule/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs11 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate192.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate192.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate192.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
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
}
else {
validate192.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
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
validate192.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate192.errors = vErrors;
return errors === 0;
}
validate192.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate191(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate191.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((data.key === undefined) && (missing0 = "key")) || ((data.inputDigest === undefined) && (missing0 = "inputDigest"))) || ((data.scopeDigest === undefined) && (missing0 = "scopeDigest"))) || ((data.targets === undefined) && (missing0 = "targets"))) || ((data.mandatory === undefined) && (missing0 = "mandatory"))) || ((data.waivable === undefined) && (missing0 = "waivable"))){
validate191.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((((key0 === "inputDigest") || (key0 === "key")) || (key0 === "mandatory")) || (key0 === "notApplicable")) || (key0 === "scopeDigest")) || (key0 === "targets")) || (key0 === "waivable"))){
validate191.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.inputDigest !== undefined){
const _errs2 = errors;
if(typeof data.inputDigest !== "string"){
validate191.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.key !== undefined){
const _errs4 = errors;
if(!(validate192(data.key, {instancePath:instancePath+"/key",parentData:data,parentDataProperty:"key",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate192.errors : vErrors.concat(validate192.errors);
errors = vErrors.length;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.mandatory !== undefined){
const _errs5 = errors;
if(typeof data.mandatory !== "boolean"){
validate191.errors = [{instancePath:instancePath+"/mandatory",schemaPath:"#/properties/mandatory/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.notApplicable !== undefined){
let data3 = data.notApplicable;
const _errs7 = errors;
const _errs8 = errors;
let valid1 = false;
const _errs9 = errors;
const _errs10 = errors;
if(errors === _errs10){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing1;
if(((data3.code === undefined) && (missing1 = "code")) || ((data3.basisDigest === undefined) && (missing1 = "basisDigest"))){
const err0 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/$defs/NotApplicableBasis/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs12 = errors;
for(const key1 in data3){
if(!((key1 === "basisDigest") || (key1 === "code"))){
const err1 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/$defs/NotApplicableBasis/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
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
if(_errs12 === errors){
if(data3.basisDigest !== undefined){
const _errs13 = errors;
if(typeof data3.basisDigest !== "string"){
const err2 = {instancePath:instancePath+"/notApplicable/basisDigest",schemaPath:"#/$defs/NotApplicableBasis/properties/basisDigest/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var valid3 = _errs13 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data3.code !== undefined){
const _errs15 = errors;
if(typeof data3.code !== "string"){
const err3 = {instancePath:instancePath+"/notApplicable/code",schemaPath:"#/$defs/NotApplicableBasis/properties/code/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid3 = _errs15 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
const err4 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/$defs/NotApplicableBasis/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
var _valid0 = _errs9 === errors;
valid1 = valid1 || _valid0;
const _errs17 = errors;
if(data3 !== null){
const err5 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/properties/notApplicable/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var _valid0 = _errs17 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err6 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/properties/notApplicable/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
validate191.errors = vErrors;
return false;
}
else {
errors = _errs8;
if(vErrors !== null){
if(_errs8){
vErrors.length = _errs8;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.scopeDigest !== undefined){
const _errs19 = errors;
if(typeof data.scopeDigest !== "string"){
validate191.errors = [{instancePath:instancePath+"/scopeDigest",schemaPath:"#/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs19 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targets !== undefined){
let data7 = data.targets;
const _errs21 = errors;
if(errors === _errs21){
if(Array.isArray(data7)){
var valid4 = true;
const len0 = data7.length;
for(let i0=0; i0<len0; i0++){
const _errs23 = errors;
if(typeof data7[i0] !== "string"){
validate191.errors = [{instancePath:instancePath+"/targets/" + i0,schemaPath:"#/properties/targets/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs23 === errors;
if(!valid4){
break;
}
}
}
else {
validate191.errors = [{instancePath:instancePath+"/targets",schemaPath:"#/properties/targets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs21 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.waivable !== undefined){
const _errs25 = errors;
if(typeof data.waivable !== "boolean"){
validate191.errors = [{instancePath:instancePath+"/waivable",schemaPath:"#/properties/waivable/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
return false;
}
var valid0 = _errs25 === errors;
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
else {
validate191.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate191.errors = vErrors;
return errors === 0;
}
validate191.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate172(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate172.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.input === undefined) && (missing0 = "input")) || ((data.proposal === undefined) && (missing0 = "proposal"))) || ((data.requirements === undefined) && (missing0 = "requirements"))){
validate172.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "input") || (key0 === "proposal")) || (key0 === "requirements"))){
validate172.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.input !== undefined){
const _errs2 = errors;
if(!(validate173(data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate173.errors : vErrors.concat(validate173.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.proposal !== undefined){
const _errs3 = errors;
if(!(validate177(data.proposal, {instancePath:instancePath+"/proposal",parentData:data,parentDataProperty:"proposal",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate177.errors : vErrors.concat(validate177.errors);
errors = vErrors.length;
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.requirements !== undefined){
let data2 = data.requirements;
const _errs4 = errors;
if(errors === _errs4){
if(Array.isArray(data2)){
var valid1 = true;
const len0 = data2.length;
for(let i0=0; i0<len0; i0++){
const _errs6 = errors;
if(!(validate191(data2[i0], {instancePath:instancePath+"/requirements/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate191.errors : vErrors.concat(validate191.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate172.errors = [{instancePath:instancePath+"/requirements",schemaPath:"#/properties/requirements/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate172.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate172.errors = vErrors;
return errors === 0;
}
validate172.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
