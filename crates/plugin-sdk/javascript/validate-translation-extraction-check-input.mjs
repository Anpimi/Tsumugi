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
export const validate = validate191;
export default validate191;
const schema207 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TranslationExtractionCheckInput","type":"object","properties":{"input":{"$ref":"#/$defs/TranslationExtractionInput"},"proposal":{"$ref":"#/$defs/TranslationExchange"},"requirements":{"type":"array","items":{"$ref":"#/$defs/CheckRequirement"}}},"additionalProperties":false,"required":["input","proposal","requirements"],"$defs":{"CapturedArtifact":{"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]},"CapturedBinaryArtifact":{"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]},"CapturedTextArtifact":{"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]},"CheckImplementation":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]},"CheckKey":{"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]},"CheckRequirement":{"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"ImportedTranslation":{"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"$ref":"#/$defs/NativeIdentityEvidence"},"source":{"$ref":"#/$defs/SourceReference"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","text","source","nativeIdentity"]},"NativeIdentityDisplay":{"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]},"NativeIdentityEvidence":{"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]},"NotApplicableBasis":{"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]},"PluginIdentity":{"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]},"ProviderSelectionBinding":{"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]},"SourceEncoding":{"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]},"SourceRange":{"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]},"TranslationExchange":{"description":"Complete captured file evidence is retained once, including an empty file.\nDeclared language is domain evidence, not an inferred project locale.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"declaredLanguage":{"type":"string"},"entries":{"type":"array","items":{"$ref":"#/$defs/ImportedTranslation"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"order":{"type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","declaredLanguage","languageEvidence","nativeScope","artifacts","entries","order"]},"TranslationExtractionInput":{"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","languageEvidence","nativeScope","artifacts"]},"TranslationLanguageEvidence":{"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]},"TranslationNativeScope":{"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]}}};
const schema208 = {"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","languageEvidence","nativeScope","artifacts"]};
const schema212 = {"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]};
const schema214 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema209 = {"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]};
const schema210 = {"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]};
const schema211 = {"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]};

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
const _errs1 = errors;
const _errs2 = errors;
if(errors === _errs2){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.id === undefined) && (missing0 = "id")) || ((data.logicalPath === undefined) && (missing0 = "logicalPath"))) || ((data.role === undefined) && (missing0 = "role"))) || ((data.sha256 === undefined) && (missing0 = "sha256"))) || ((data.utf8 === undefined) && (missing0 = "utf8"))){
const err0 = {instancePath,schemaPath:"#/$defs/CapturedTextArtifact/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs4 = errors;
for(const key0 in data){
if(!(((((key0 === "id") || (key0 === "logicalPath")) || (key0 === "role")) || (key0 === "sha256")) || (key0 === "utf8"))){
const err1 = {instancePath,schemaPath:"#/$defs/CapturedTextArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
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
if(_errs4 === errors){
if(data.id !== undefined){
const _errs5 = errors;
if(typeof data.id !== "string"){
const err2 = {instancePath:instancePath+"/id",schemaPath:"#/$defs/CapturedTextArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var valid2 = _errs5 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.logicalPath !== undefined){
const _errs7 = errors;
if(typeof data.logicalPath !== "string"){
const err3 = {instancePath:instancePath+"/logicalPath",schemaPath:"#/$defs/CapturedTextArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid2 = _errs7 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.role !== undefined){
const _errs9 = errors;
if(typeof data.role !== "string"){
const err4 = {instancePath:instancePath+"/role",schemaPath:"#/$defs/CapturedTextArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.sha256 !== undefined){
const _errs11 = errors;
if(typeof data.sha256 !== "string"){
const err5 = {instancePath:instancePath+"/sha256",schemaPath:"#/$defs/CapturedTextArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid2 = _errs11 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.utf8 !== undefined){
const _errs13 = errors;
if(typeof data.utf8 !== "string"){
const err6 = {instancePath:instancePath+"/utf8",schemaPath:"#/$defs/CapturedTextArtifact/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
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
}
}
else {
const err7 = {instancePath,schemaPath:"#/$defs/CapturedTextArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
valid0 = valid0 || _valid0;
if(_valid0){
var props0 = true;
}
const _errs15 = errors;
const _errs16 = errors;
if(errors === _errs16){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if((((((data.id === undefined) && (missing1 = "id")) || ((data.logicalPath === undefined) && (missing1 = "logicalPath"))) || ((data.role === undefined) && (missing1 = "role"))) || ((data.sha256 === undefined) && (missing1 = "sha256"))) || ((data.base64 === undefined) && (missing1 = "base64"))){
const err8 = {instancePath,schemaPath:"#/$defs/CapturedBinaryArtifact/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
else {
const _errs18 = errors;
for(const key1 in data){
if(!(((((key1 === "base64") || (key1 === "id")) || (key1 === "logicalPath")) || (key1 === "role")) || (key1 === "sha256"))){
const err9 = {instancePath,schemaPath:"#/$defs/CapturedBinaryArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
break;
}
}
if(_errs18 === errors){
if(data.base64 !== undefined){
const _errs19 = errors;
if(typeof data.base64 !== "string"){
const err10 = {instancePath:instancePath+"/base64",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/base64/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.id !== undefined){
const _errs21 = errors;
if(typeof data.id !== "string"){
const err11 = {instancePath:instancePath+"/id",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.logicalPath !== undefined){
const _errs23 = errors;
if(typeof data.logicalPath !== "string"){
const err12 = {instancePath:instancePath+"/logicalPath",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
var valid4 = _errs23 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.role !== undefined){
const _errs25 = errors;
if(typeof data.role !== "string"){
const err13 = {instancePath:instancePath+"/role",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
var valid4 = _errs25 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.sha256 !== undefined){
const _errs27 = errors;
if(typeof data.sha256 !== "string"){
const err14 = {instancePath:instancePath+"/sha256",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
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
}
else {
const err15 = {instancePath,schemaPath:"#/$defs/CapturedBinaryArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
var _valid0 = _errs15 === errors;
valid0 = valid0 || _valid0;
if(_valid0){
if(props0 !== true){
props0 = true;
}
}
if(!valid0){
const err16 = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
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

const schema213 = {"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]};

function validate195(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate195.evaluated;
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
validate195.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "namespace") || (key0 === "policy"))){
validate195.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.namespace !== undefined){
const _errs2 = errors;
if(typeof data.namespace !== "string"){
validate195.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate195.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate195.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate195.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate195.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate195.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate195.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate195.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate195.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate195.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate195.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate195.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate195.errors = vErrors;
return errors === 0;
}
validate195.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


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
if(((((((((data.profile === undefined) && (missing0 = "profile")) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.sourceSnapshotId === undefined) && (missing0 = "sourceSnapshotId"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.languageEvidence === undefined) && (missing0 = "languageEvidence"))) || ((data.nativeScope === undefined) && (missing0 = "nativeScope"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))){
validate192.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "artifacts") || (key0 === "importId")) || (key0 === "languageEvidence")) || (key0 === "nativeScope")) || (key0 === "profile")) || (key0 === "sourceSetId")) || (key0 === "sourceSnapshotId")) || (key0 === "targetLanguage"))){
validate192.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
const _errs4 = errors;
if(!(validate193(data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate193.errors : vErrors.concat(validate193.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate192.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
const _errs5 = errors;
if(typeof data.importId !== "string"){
validate192.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/properties/importId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.languageEvidence !== undefined){
let data3 = data.languageEvidence;
const _errs7 = errors;
if(typeof data3 !== "string"){
validate192.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(data3 === "user-confirmed")){
validate192.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/enum",keyword:"enum",params:{allowedValues: schema212.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeScope !== undefined){
const _errs10 = errors;
if(!(validate195(data.nativeScope, {instancePath:instancePath+"/nativeScope",parentData:data,parentDataProperty:"nativeScope",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate195.errors : vErrors.concat(validate195.errors);
errors = vErrors.length;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data5 = data.profile;
const _errs11 = errors;
const _errs12 = errors;
if(errors === _errs12){
if(data5 && typeof data5 == "object" && !Array.isArray(data5)){
let missing1;
if((((data5.id === undefined) && (missing1 = "id")) || ((data5.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data5.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate192.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs14 = errors;
for(const key1 in data5){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate192.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs14 === errors){
if(data5.behaviorVersion !== undefined){
let data6 = data5.behaviorVersion;
const _errs15 = errors;
if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){
validate192.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs15){
if((typeof data6 == "number") && (isFinite(data6))){
if(data6 > 4294967295 || isNaN(data6)){
validate192.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data6 < 1 || isNaN(data6)){
validate192.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs15 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data5.id !== undefined){
const _errs17 = errors;
if(typeof data5.id !== "string"){
validate192.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs17 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data5.schemaVersion !== undefined){
let data8 = data5.schemaVersion;
const _errs19 = errors;
if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){
validate192.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs19){
if((typeof data8 == "number") && (isFinite(data8))){
if(data8 > 4294967295 || isNaN(data8)){
validate192.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data8 < 1 || isNaN(data8)){
validate192.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs19 === errors;
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
validate192.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs11 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs21 = errors;
if(typeof data.sourceSetId !== "string"){
validate192.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs21 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSnapshotId !== undefined){
const _errs23 = errors;
if(typeof data.sourceSnapshotId !== "string"){
validate192.errors = [{instancePath:instancePath+"/sourceSnapshotId",schemaPath:"#/properties/sourceSnapshotId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs23 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs25 = errors;
if(typeof data.targetLanguage !== "string"){
validate192.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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

const schema216 = {"description":"Complete captured file evidence is retained once, including an empty file.\nDeclared language is domain evidence, not an inferred project locale.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"declaredLanguage":{"type":"string"},"entries":{"type":"array","items":{"$ref":"#/$defs/ImportedTranslation"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"order":{"type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","declaredLanguage","languageEvidence","nativeScope","artifacts","entries","order"]};
const func1 = Object.prototype.hasOwnProperty;
const schema217 = {"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"$ref":"#/$defs/NativeIdentityEvidence"},"source":{"$ref":"#/$defs/SourceReference"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","text","source","nativeIdentity"]};
const schema218 = {"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]};
const schema219 = {"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]};
const schema220 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema221 = {"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema222 = {"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]};

function validate204(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate204.evaluated;
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
validate204.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate204.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate204.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme")) || (data0 === "raw-byte"))){
validate204.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/enum",keyword:"enum",params:{allowedValues: schema222.enum},message:"must be equal to one of the allowed values"}];
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
validate204.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate204.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate204.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate204.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate204.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate204.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate204.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate204.errors = vErrors;
return errors === 0;
}
validate204.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate203(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate203.evaluated;
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
validate203.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate203.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate203.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate204(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate204.errors : vErrors.concat(validate204.errors);
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
validate203.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate203.errors = vErrors;
return errors === 0;
}
validate203.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate202(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate202.evaluated;
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
validate202.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "source") || (key0 === "value"))){
validate202.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate203(data0, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate203.errors : vErrors.concat(validate203.errors);
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
validate202.errors = vErrors;
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
validate202.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate202.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate202.errors = vErrors;
return errors === 0;
}
validate202.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate201(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate201.evaluated;
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
validate201.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "display") || (key0 === "namespace")) || (key0 === "policy")) || (key0 === "value"))){
validate201.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.display !== undefined){
const _errs2 = errors;
if(!(validate202(data.display, {instancePath:instancePath+"/display",parentData:data,parentDataProperty:"display",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate202.errors : vErrors.concat(validate202.errors);
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
validate201.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate201.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate201.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate201.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate201.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate201.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate201.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate201.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs13){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate201.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate201.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate201.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate201.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate201.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate201.errors = vErrors;
return errors === 0;
}
validate201.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate200(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate200.evaluated;
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
validate200.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "id") || (key0 === "nativeIdentity")) || (key0 === "source")) || (key0 === "text"))){
validate200.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate200.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate201(data.nativeIdentity, {instancePath:instancePath+"/nativeIdentity",parentData:data,parentDataProperty:"nativeIdentity",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate201.errors : vErrors.concat(validate201.errors);
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
if(!(validate203(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate203.errors : vErrors.concat(validate203.errors);
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
validate200.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate200.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate200.errors = vErrors;
return errors === 0;
}
validate200.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate198(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate198.evaluated;
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
validate198.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(func1.call(schema216.properties, key0))){
validate198.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
const _errs4 = errors;
if(!(validate193(data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate193.errors : vErrors.concat(validate193.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate198.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
const _errs5 = errors;
if(typeof data.declaredLanguage !== "string"){
validate198.errors = [{instancePath:instancePath+"/declaredLanguage",schemaPath:"#/properties/declaredLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.entries !== undefined){
let data3 = data.entries;
const _errs7 = errors;
if(errors === _errs7){
if(Array.isArray(data3)){
var valid2 = true;
const len1 = data3.length;
for(let i1=0; i1<len1; i1++){
const _errs9 = errors;
if(!(validate200(data3[i1], {instancePath:instancePath+"/entries/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate200.errors : vErrors.concat(validate200.errors);
errors = vErrors.length;
}
var valid2 = _errs9 === errors;
if(!valid2){
break;
}
}
}
else {
validate198.errors = [{instancePath:instancePath+"/entries",schemaPath:"#/properties/entries/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.importId !== undefined){
const _errs10 = errors;
if(typeof data.importId !== "string"){
validate198.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/properties/importId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.languageEvidence !== undefined){
let data6 = data.languageEvidence;
const _errs12 = errors;
if(typeof data6 !== "string"){
validate198.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(data6 === "user-confirmed")){
validate198.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/enum",keyword:"enum",params:{allowedValues: schema212.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeScope !== undefined){
const _errs15 = errors;
if(!(validate195(data.nativeScope, {instancePath:instancePath+"/nativeScope",parentData:data,parentDataProperty:"nativeScope",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate195.errors : vErrors.concat(validate195.errors);
errors = vErrors.length;
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.order !== undefined){
let data8 = data.order;
const _errs16 = errors;
if(errors === _errs16){
if(Array.isArray(data8)){
var valid4 = true;
const len2 = data8.length;
for(let i2=0; i2<len2; i2++){
const _errs18 = errors;
if(typeof data8[i2] !== "string"){
validate198.errors = [{instancePath:instancePath+"/order/" + i2,schemaPath:"#/properties/order/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs18 === errors;
if(!valid4){
break;
}
}
}
else {
validate198.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs16 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data10 = data.profile;
const _errs20 = errors;
const _errs21 = errors;
if(errors === _errs21){
if(data10 && typeof data10 == "object" && !Array.isArray(data10)){
let missing1;
if((((data10.id === undefined) && (missing1 = "id")) || ((data10.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data10.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate198.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs23 = errors;
for(const key1 in data10){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate198.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs23 === errors){
if(data10.behaviorVersion !== undefined){
let data11 = data10.behaviorVersion;
const _errs24 = errors;
if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){
validate198.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs24){
if((typeof data11 == "number") && (isFinite(data11))){
if(data11 > 4294967295 || isNaN(data11)){
validate198.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data11 < 1 || isNaN(data11)){
validate198.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid6 = _errs24 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data10.id !== undefined){
const _errs26 = errors;
if(typeof data10.id !== "string"){
validate198.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid6 = _errs26 === errors;
}
else {
var valid6 = true;
}
if(valid6){
if(data10.schemaVersion !== undefined){
let data13 = data10.schemaVersion;
const _errs28 = errors;
if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){
validate198.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs28){
if((typeof data13 == "number") && (isFinite(data13))){
if(data13 > 4294967295 || isNaN(data13)){
validate198.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data13 < 1 || isNaN(data13)){
validate198.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
}
}
}
}
}
else {
validate198.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs20 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs30 = errors;
if(typeof data.sourceSetId !== "string"){
validate198.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs30 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSnapshotId !== undefined){
const _errs32 = errors;
if(typeof data.sourceSnapshotId !== "string"){
validate198.errors = [{instancePath:instancePath+"/sourceSnapshotId",schemaPath:"#/properties/sourceSnapshotId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs32 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs34 = errors;
if(typeof data.targetLanguage !== "string"){
validate198.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs34 === errors;
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
validate198.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate198.errors = vErrors;
return errors === 0;
}
validate198.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema226 = {"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]};
const schema233 = {"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]};
const schema227 = {"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]};
const schema228 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]};
const schema230 = {"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]};
const schema231 = {"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]};

function validate216(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate216.evaluated;
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
validate216.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "componentId") || (key0 === "contributionId")) || (key0 === "packageDigest")) || (key0 === "plugin"))){
validate216.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.componentId !== undefined){
const _errs2 = errors;
if(typeof data.componentId !== "string"){
validate216.errors = [{instancePath:instancePath+"/componentId",schemaPath:"#/properties/componentId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate216.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate216.errors = [{instancePath:instancePath+"/packageDigest",schemaPath:"#/properties/packageDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate216.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs11 = errors;
for(const key1 in data3){
if(!(((key1 === "id") || (key1 === "publisher")) || (key1 === "version"))){
validate216.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs11 === errors){
if(data3.id !== undefined){
const _errs12 = errors;
if(typeof data3.id !== "string"){
validate216.errors = [{instancePath:instancePath+"/plugin/id",schemaPath:"#/$defs/PluginIdentity/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate216.errors = [{instancePath:instancePath+"/plugin/publisher",schemaPath:"#/$defs/PluginIdentity/properties/publisher/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate216.errors = [{instancePath:instancePath+"/plugin/version",schemaPath:"#/$defs/PluginIdentity/properties/version/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate216.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate216.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate216.errors = vErrors;
return errors === 0;
}
validate216.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate215(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate215.evaluated;
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
if(!(validate216(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate216.errors : vErrors.concat(validate216.errors);
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
validate215.errors = vErrors;
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
validate215.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate215.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate214(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate214.evaluated;
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
validate214.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "implementation") || (key0 === "rule"))){
validate214.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.implementation !== undefined){
const _errs2 = errors;
if(!(validate215(data.implementation, {instancePath:instancePath+"/implementation",parentData:data,parentDataProperty:"implementation",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate215.errors : vErrors.concat(validate215.errors);
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
validate214.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs6 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate214.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs6 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate214.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate214.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate214.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate214.errors = [{instancePath:instancePath+"/rule/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate214.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate214.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate214.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate214.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate214.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate214.errors = vErrors;
return errors === 0;
}
validate214.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate213(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate213.evaluated;
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
validate213.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((((key0 === "inputDigest") || (key0 === "key")) || (key0 === "mandatory")) || (key0 === "notApplicable")) || (key0 === "scopeDigest")) || (key0 === "targets")) || (key0 === "waivable"))){
validate213.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.inputDigest !== undefined){
const _errs2 = errors;
if(typeof data.inputDigest !== "string"){
validate213.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate214(data.key, {instancePath:instancePath+"/key",parentData:data,parentDataProperty:"key",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate214.errors : vErrors.concat(validate214.errors);
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
validate213.errors = [{instancePath:instancePath+"/mandatory",schemaPath:"#/properties/mandatory/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
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
validate213.errors = vErrors;
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
validate213.errors = [{instancePath:instancePath+"/scopeDigest",schemaPath:"#/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate213.errors = [{instancePath:instancePath+"/targets/" + i0,schemaPath:"#/properties/targets/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs23 === errors;
if(!valid4){
break;
}
}
}
else {
validate213.errors = [{instancePath:instancePath+"/targets",schemaPath:"#/properties/targets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate213.errors = [{instancePath:instancePath+"/waivable",schemaPath:"#/properties/waivable/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
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
validate213.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate213.errors = vErrors;
return errors === 0;
}
validate213.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


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
if((((data.input === undefined) && (missing0 = "input")) || ((data.proposal === undefined) && (missing0 = "proposal"))) || ((data.requirements === undefined) && (missing0 = "requirements"))){
validate191.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "input") || (key0 === "proposal")) || (key0 === "requirements"))){
validate191.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.input !== undefined){
const _errs2 = errors;
if(!(validate192(data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate192.errors : vErrors.concat(validate192.errors);
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
if(!(validate198(data.proposal, {instancePath:instancePath+"/proposal",parentData:data,parentDataProperty:"proposal",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate198.errors : vErrors.concat(validate198.errors);
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
if(!(validate213(data2[i0], {instancePath:instancePath+"/requirements/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate213.errors : vErrors.concat(validate213.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate191.errors = [{instancePath:instancePath+"/requirements",schemaPath:"#/properties/requirements/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate191.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate191.errors = vErrors;
return errors === 0;
}
validate191.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
