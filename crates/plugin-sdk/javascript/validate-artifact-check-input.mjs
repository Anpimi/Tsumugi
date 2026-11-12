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
export const validate = validate129;
export default validate129;
const schema145 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ArtifactCheckInput","type":"object","properties":{"input":{"$ref":"#/$defs/BuildInput"},"output":{"$ref":"#/$defs/ArtifactSet"},"requirements":{"type":"array","items":{"$ref":"#/$defs/CheckRequirement"}}},"additionalProperties":false,"required":["input","output","requirements"],"$defs":{"ArtifactSet":{"description":"Actual text or binary output. Exact bytes do not establish domain conformance\nor release eligibility. Logical paths grant no filesystem authority.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","sourceSetId","targetLanguage","artifacts"]},"BuildInput":{"type":"object","properties":{"configuration":{"description":"Exact domain configuration; an empty collection means no configuration.","type":"array","items":{"$ref":"#/$defs/EncodedPayload"}},"outputLimits":{"description":"Captured by the trusted planner, never replaced by returned artifacts.","$ref":"#/$defs/BuildOutputLimits"},"outputPaths":{"description":"Complete authorized relative output paths, fixed before dispatch.","type":"array","items":{"type":"string"}},"source":{"$ref":"#/$defs/ContentExchange"},"targetLanguage":{"type":"string"},"targets":{"type":"array","items":{"$ref":"#/$defs/BuildTarget"}}},"additionalProperties":false,"required":["source","targetLanguage","targets","configuration","outputPaths","outputLimits"]},"BuildOutputLimits":{"type":"object","properties":{"maxArtifacts":{"type":"integer","maximum":32,"minimum":1},"maxTotalBytes":{"type":"integer","maximum":268435456,"minimum":1}},"additionalProperties":false,"required":["maxArtifacts","maxTotalBytes"]},"BuildTarget":{"description":"One already decided text per source unit, even when it has many occurrences.\nNo candidate selection, review decision or project write handle is supplied.","type":"object","properties":{"sourceRevisionId":{"type":"string"},"text":{"type":"string"},"unitId":{"type":"string"}},"additionalProperties":false,"required":["unitId","sourceRevisionId","text"]},"CapturedArtifact":{"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]},"CapturedBinaryArtifact":{"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]},"CapturedTextArtifact":{"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]},"CheckImplementation":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]},"CheckKey":{"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]},"CheckRequirement":{"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]},"ContentExchange":{"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"domainBlocks":{"type":"array","items":{"$ref":"#/$defs/DomainBlock"}},"order":{"description":"Exact occurrence order. Hierarchies and other graphs use typed relations.","type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"relations":{"type":"array","items":{"$ref":"#/$defs/ContentRelation"}},"sourceLanguage":{"type":"string"},"sourceSetId":{"type":"string"},"units":{"type":"array","items":{"$ref":"#/$defs/ContentUnit"}}},"additionalProperties":false,"required":["profile","sourceSetId","sourceLanguage","artifacts","units","order","relations","domainBlocks"]},"ContentOccurrence":{"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"anyOf":[{"$ref":"#/$defs/NativeIdentityEvidence"},{"type":"null"}]},"source":{"$ref":"#/$defs/SourceReference"}},"additionalProperties":false,"required":["id","source"]},"ContentRelation":{"type":"object","properties":{"fromOccurrence":{"type":"string"},"kind":{"$ref":"#/$defs/ContractRef"},"toOccurrence":{"type":"string"}},"additionalProperties":false,"required":["kind","fromOccurrence","toOccurrence"]},"ContentTarget":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"snapshot"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"unit"}},"additionalProperties":false,"required":["kind","id"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"occurrence"}},"additionalProperties":false,"required":["kind","id"]}]},"ContentUnit":{"type":"object","properties":{"id":{"description":"Operation-local reference or a captured project identity, as specified by\nthe capability. A plugin cannot allocate authoritative project revisions.","type":"string"},"occurrences":{"type":"array","items":{"$ref":"#/$defs/ContentOccurrence"}},"protectedFragments":{"type":"array","items":{"$ref":"#/$defs/ProtectedFragment"}},"sourceRevisionId":{"description":"During extraction this is an operation-local proposal reference. Only\nCore may map it to an authoritative project source revision.","type":"string"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","sourceRevisionId","text","occurrences","protectedFragments"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"DomainBlock":{"type":"object","properties":{"handling":{"$ref":"#/$defs/ExtensionHandling"},"payloadUtf8":{"description":"Exact UTF-8 payload, intentionally not an open JSON property bag. Its\nschema is interpreted by the domain, without loss through Value parsing.","type":"string"},"schema":{"$ref":"#/$defs/ContractRef"},"target":{"$ref":"#/$defs/ContentTarget"}},"additionalProperties":false,"required":["target","schema","handling","payloadUtf8"]},"EncodedPayload":{"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]},"ExtensionHandling":{"oneOf":[{"description":"An operation that needs this block must have the exact interpreter.","type":"string","const":"required"},{"description":"Preserve the payload exactly, including when its schema is understood.","type":"string","const":"preserve"},{"description":"Interpretation is optional; an unknown payload is still preserved.","type":"string","const":"optional"}]},"NativeIdentityDisplay":{"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]},"NativeIdentityEvidence":{"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]},"NotApplicableBasis":{"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]},"PluginIdentity":{"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]},"ProtectedFragment":{"type":"object","properties":{"kind":{"$ref":"#/$defs/ContractRef"},"range":{"description":"Coordinates into the decoded unit text, not its original artifact.","$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["kind","range"]},"ProviderSelectionBinding":{"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]},"SourceEncoding":{"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]},"SourceRange":{"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]},"TextEncoding":{"type":"string","enum":["utf8-byte","utf16","grapheme"]},"TextRange":{"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]}}};
const schema146 = {"type":"object","properties":{"configuration":{"description":"Exact domain configuration; an empty collection means no configuration.","type":"array","items":{"$ref":"#/$defs/EncodedPayload"}},"outputLimits":{"description":"Captured by the trusted planner, never replaced by returned artifacts.","$ref":"#/$defs/BuildOutputLimits"},"outputPaths":{"description":"Complete authorized relative output paths, fixed before dispatch.","type":"array","items":{"type":"string"}},"source":{"$ref":"#/$defs/ContentExchange"},"targetLanguage":{"type":"string"},"targets":{"type":"array","items":{"$ref":"#/$defs/BuildTarget"}}},"additionalProperties":false,"required":["source","targetLanguage","targets","configuration","outputPaths","outputLimits"]};
const schema149 = {"type":"object","properties":{"maxArtifacts":{"type":"integer","maximum":32,"minimum":1},"maxTotalBytes":{"type":"integer","maximum":268435456,"minimum":1}},"additionalProperties":false,"required":["maxArtifacts","maxTotalBytes"]};
const schema173 = {"description":"One already decided text per source unit, even when it has many occurrences.\nNo candidate selection, review decision or project write handle is supplied.","type":"object","properties":{"sourceRevisionId":{"type":"string"},"text":{"type":"string"},"unitId":{"type":"string"}},"additionalProperties":false,"required":["unitId","sourceRevisionId","text"]};
const schema147 = {"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]};
const schema148 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};

function validate131(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate131.evaluated;
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
validate131.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "schema") || (key0 === "sha256")) || (key0 === "utf8"))){
validate131.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
validate131.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate131.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate131.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate131.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate131.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate131.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate131.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate131.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate131.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate131.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate131.errors = [{instancePath:instancePath+"/sha256",schemaPath:"#/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate131.errors = [{instancePath:instancePath+"/utf8",schemaPath:"#/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate131.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate131.errors = vErrors;
return errors === 0;
}
validate131.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema150 = {"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"domainBlocks":{"type":"array","items":{"$ref":"#/$defs/DomainBlock"}},"order":{"description":"Exact occurrence order. Hierarchies and other graphs use typed relations.","type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"relations":{"type":"array","items":{"$ref":"#/$defs/ContentRelation"}},"sourceLanguage":{"type":"string"},"sourceSetId":{"type":"string"},"units":{"type":"array","items":{"$ref":"#/$defs/ContentUnit"}}},"additionalProperties":false,"required":["profile","sourceSetId","sourceLanguage","artifacts","units","order","relations","domainBlocks"]};
const schema151 = {"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]};
const schema152 = {"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]};
const schema153 = {"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]};

function validate134(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate134.evaluated;
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
validate134.errors = vErrors;
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
validate134.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate134.evaluated = {"dynamicProps":true,"dynamicItems":false};

const schema154 = {"type":"object","properties":{"handling":{"$ref":"#/$defs/ExtensionHandling"},"payloadUtf8":{"description":"Exact UTF-8 payload, intentionally not an open JSON property bag. Its\nschema is interpreted by the domain, without loss through Value parsing.","type":"string"},"schema":{"$ref":"#/$defs/ContractRef"},"target":{"$ref":"#/$defs/ContentTarget"}},"additionalProperties":false,"required":["target","schema","handling","payloadUtf8"]};
const schema155 = {"oneOf":[{"description":"An operation that needs this block must have the exact interpreter.","type":"string","const":"required"},{"description":"Preserve the payload exactly, including when its schema is understood.","type":"string","const":"preserve"},{"description":"Interpretation is optional; an unknown payload is still preserved.","type":"string","const":"optional"}]};
const schema157 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"snapshot"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"unit"}},"additionalProperties":false,"required":["kind","id"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"occurrence"}},"additionalProperties":false,"required":["kind","id"]}]};

function validate136(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate136.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.target === undefined) && (missing0 = "target")) || ((data.schema === undefined) && (missing0 = "schema"))) || ((data.handling === undefined) && (missing0 = "handling"))) || ((data.payloadUtf8 === undefined) && (missing0 = "payloadUtf8"))){
validate136.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "handling") || (key0 === "payloadUtf8")) || (key0 === "schema")) || (key0 === "target"))){
validate136.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.handling !== undefined){
let data0 = data.handling;
const _errs2 = errors;
const _errs4 = errors;
let valid2 = false;
let passing0 = null;
const _errs5 = errors;
if(typeof data0 !== "string"){
const err0 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf/0/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
if("required" !== data0){
const err1 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf/0/const",keyword:"const",params:{allowedValue: "required"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
var _valid0 = _errs5 === errors;
if(_valid0){
valid2 = true;
passing0 = 0;
}
const _errs7 = errors;
if(typeof data0 !== "string"){
const err2 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf/1/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("preserve" !== data0){
const err3 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf/1/const",keyword:"const",params:{allowedValue: "preserve"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var _valid0 = _errs7 === errors;
if(_valid0 && valid2){
valid2 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid2 = true;
passing0 = 1;
}
const _errs9 = errors;
if(typeof data0 !== "string"){
const err4 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf/2/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
if("optional" !== data0){
const err5 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf/2/const",keyword:"const",params:{allowedValue: "optional"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var _valid0 = _errs9 === errors;
if(_valid0 && valid2){
valid2 = false;
passing0 = [passing0, 2];
}
else {
if(_valid0){
valid2 = true;
passing0 = 2;
}
}
}
if(!valid2){
const err6 = {instancePath:instancePath+"/handling",schemaPath:"#/$defs/ExtensionHandling/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
validate136.errors = vErrors;
return false;
}
else {
errors = _errs4;
if(vErrors !== null){
if(_errs4){
vErrors.length = _errs4;
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
if(data.payloadUtf8 !== undefined){
const _errs11 = errors;
if(typeof data.payloadUtf8 !== "string"){
validate136.errors = [{instancePath:instancePath+"/payloadUtf8",schemaPath:"#/properties/payloadUtf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs11 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.schema !== undefined){
let data2 = data.schema;
const _errs13 = errors;
const _errs14 = errors;
if(errors === _errs14){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing1;
if((((data2.id === undefined) && (missing1 = "id")) || ((data2.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data2.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate136.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs16 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate136.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs16 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs17 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate136.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs17){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate136.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate136.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs17 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data2.id !== undefined){
const _errs19 = errors;
if(typeof data2.id !== "string"){
validate136.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data2.schemaVersion !== undefined){
let data5 = data2.schemaVersion;
const _errs21 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
validate136.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs21){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate136.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate136.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
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
}
else {
validate136.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs13 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.target !== undefined){
let data6 = data.target;
const _errs23 = errors;
const _errs25 = errors;
let valid6 = false;
let passing1 = null;
const _errs26 = errors;
if(errors === _errs26){
if(data6 && typeof data6 == "object" && !Array.isArray(data6)){
let missing2;
if((data6.kind === undefined) && (missing2 = "kind")){
const err7 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/0/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
const _errs28 = errors;
for(const key2 in data6){
if(!(key2 === "kind")){
const err8 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
break;
}
}
if(_errs28 === errors){
if(data6.kind !== undefined){
let data7 = data6.kind;
if(typeof data7 !== "string"){
const err9 = {instancePath:instancePath+"/target/kind",schemaPath:"#/$defs/ContentTarget/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
if("snapshot" !== data7){
const err10 = {instancePath:instancePath+"/target/kind",schemaPath:"#/$defs/ContentTarget/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "snapshot"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
}
}
}
}
else {
const err11 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
}
var _valid1 = _errs26 === errors;
if(_valid1){
valid6 = true;
passing1 = 0;
var props0 = true;
}
const _errs31 = errors;
if(errors === _errs31){
if(data6 && typeof data6 == "object" && !Array.isArray(data6)){
let missing3;
if(((data6.kind === undefined) && (missing3 = "kind")) || ((data6.id === undefined) && (missing3 = "id"))){
const err12 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/1/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
else {
const _errs33 = errors;
for(const key3 in data6){
if(!((key3 === "id") || (key3 === "kind"))){
const err13 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
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
if(_errs33 === errors){
if(data6.id !== undefined){
const _errs34 = errors;
if(typeof data6.id !== "string"){
const err14 = {instancePath:instancePath+"/target/id",schemaPath:"#/$defs/ContentTarget/oneOf/1/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
var valid8 = _errs34 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data6.kind !== undefined){
let data9 = data6.kind;
const _errs36 = errors;
if(typeof data9 !== "string"){
const err15 = {instancePath:instancePath+"/target/kind",schemaPath:"#/$defs/ContentTarget/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
if("unit" !== data9){
const err16 = {instancePath:instancePath+"/target/kind",schemaPath:"#/$defs/ContentTarget/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "unit"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
var valid8 = _errs36 === errors;
}
else {
var valid8 = true;
}
}
}
}
}
else {
const err17 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
}
var _valid1 = _errs31 === errors;
if(_valid1 && valid6){
valid6 = false;
passing1 = [passing1, 1];
}
else {
if(_valid1){
valid6 = true;
passing1 = 1;
if(props0 !== true){
props0 = true;
}
}
const _errs38 = errors;
if(errors === _errs38){
if(data6 && typeof data6 == "object" && !Array.isArray(data6)){
let missing4;
if(((data6.kind === undefined) && (missing4 = "kind")) || ((data6.id === undefined) && (missing4 = "id"))){
const err18 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/2/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
else {
const _errs40 = errors;
for(const key4 in data6){
if(!((key4 === "id") || (key4 === "kind"))){
const err19 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
break;
}
}
if(_errs40 === errors){
if(data6.id !== undefined){
const _errs41 = errors;
if(typeof data6.id !== "string"){
const err20 = {instancePath:instancePath+"/target/id",schemaPath:"#/$defs/ContentTarget/oneOf/2/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
var valid9 = _errs41 === errors;
}
else {
var valid9 = true;
}
if(valid9){
if(data6.kind !== undefined){
let data11 = data6.kind;
const _errs43 = errors;
if(typeof data11 !== "string"){
const err21 = {instancePath:instancePath+"/target/kind",schemaPath:"#/$defs/ContentTarget/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
if("occurrence" !== data11){
const err22 = {instancePath:instancePath+"/target/kind",schemaPath:"#/$defs/ContentTarget/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "occurrence"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
}
var valid9 = _errs43 === errors;
}
else {
var valid9 = true;
}
}
}
}
}
else {
const err23 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
}
var _valid1 = _errs38 === errors;
if(_valid1 && valid6){
valid6 = false;
passing1 = [passing1, 2];
}
else {
if(_valid1){
valid6 = true;
passing1 = 2;
if(props0 !== true){
props0 = true;
}
}
}
}
if(!valid6){
const err24 = {instancePath:instancePath+"/target",schemaPath:"#/$defs/ContentTarget/oneOf",keyword:"oneOf",params:{passingSchemas: passing1},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
validate136.errors = vErrors;
return false;
}
else {
errors = _errs25;
if(vErrors !== null){
if(_errs25){
vErrors.length = _errs25;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs23 === errors;
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
validate136.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate136.errors = vErrors;
return errors === 0;
}
validate136.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema159 = {"type":"object","properties":{"fromOccurrence":{"type":"string"},"kind":{"$ref":"#/$defs/ContractRef"},"toOccurrence":{"type":"string"}},"additionalProperties":false,"required":["kind","fromOccurrence","toOccurrence"]};

function validate138(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate138.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.kind === undefined) && (missing0 = "kind")) || ((data.fromOccurrence === undefined) && (missing0 = "fromOccurrence"))) || ((data.toOccurrence === undefined) && (missing0 = "toOccurrence"))){
validate138.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "fromOccurrence") || (key0 === "kind")) || (key0 === "toOccurrence"))){
validate138.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.fromOccurrence !== undefined){
const _errs2 = errors;
if(typeof data.fromOccurrence !== "string"){
validate138.errors = [{instancePath:instancePath+"/fromOccurrence",schemaPath:"#/properties/fromOccurrence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.kind !== undefined){
let data1 = data.kind;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate138.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate138.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate138.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate138.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate138.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate138.errors = [{instancePath:instancePath+"/kind/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate138.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate138.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate138.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate138.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.toOccurrence !== undefined){
const _errs14 = errors;
if(typeof data.toOccurrence !== "string"){
validate138.errors = [{instancePath:instancePath+"/toOccurrence",schemaPath:"#/properties/toOccurrence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate138.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate138.errors = vErrors;
return errors === 0;
}
validate138.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema161 = {"type":"object","properties":{"id":{"description":"Operation-local reference or a captured project identity, as specified by\nthe capability. A plugin cannot allocate authoritative project revisions.","type":"string"},"occurrences":{"type":"array","items":{"$ref":"#/$defs/ContentOccurrence"}},"protectedFragments":{"type":"array","items":{"$ref":"#/$defs/ProtectedFragment"}},"sourceRevisionId":{"description":"During extraction this is an operation-local proposal reference. Only\nCore may map it to an authoritative project source revision.","type":"string"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","sourceRevisionId","text","occurrences","protectedFragments"]};
const schema162 = {"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"anyOf":[{"$ref":"#/$defs/NativeIdentityEvidence"},{"type":"null"}]},"source":{"$ref":"#/$defs/SourceReference"}},"additionalProperties":false,"required":["id","source"]};
const schema163 = {"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]};
const schema164 = {"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]};
const schema165 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema166 = {"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema167 = {"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]};

function validate145(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate145.evaluated;
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
validate145.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate145.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate145.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme")) || (data0 === "raw-byte"))){
validate145.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/enum",keyword:"enum",params:{allowedValues: schema167.enum},message:"must be equal to one of the allowed values"}];
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
validate145.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate145.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate145.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate145.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate145.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate145.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate145.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate145.errors = vErrors;
return errors === 0;
}
validate145.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate144(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate144.evaluated;
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
validate144.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate144.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate144.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate145(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate145.errors : vErrors.concat(validate145.errors);
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
validate144.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate144.errors = vErrors;
return errors === 0;
}
validate144.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate143(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate143.evaluated;
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
validate143.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "source") || (key0 === "value"))){
validate143.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate144(data0, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate144.errors : vErrors.concat(validate144.errors);
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
validate143.errors = vErrors;
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
validate143.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate143.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate143.errors = vErrors;
return errors === 0;
}
validate143.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate142(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate142.evaluated;
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
validate142.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "display") || (key0 === "namespace")) || (key0 === "policy")) || (key0 === "value"))){
validate142.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.display !== undefined){
const _errs2 = errors;
if(!(validate143(data.display, {instancePath:instancePath+"/display",parentData:data,parentDataProperty:"display",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate143.errors : vErrors.concat(validate143.errors);
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
validate142.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate142.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate142.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate142.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate142.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate142.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate142.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate142.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs13){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate142.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate142.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate142.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate142.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate142.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate142.errors = vErrors;
return errors === 0;
}
validate142.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate141(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate141.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.id === undefined) && (missing0 = "id")) || ((data.source === undefined) && (missing0 = "source"))){
validate141.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "id") || (key0 === "nativeIdentity")) || (key0 === "source"))){
validate141.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate141.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeIdentity !== undefined){
let data1 = data.nativeIdentity;
const _errs4 = errors;
const _errs5 = errors;
let valid1 = false;
const _errs6 = errors;
if(!(validate142(data1, {instancePath:instancePath+"/nativeIdentity",parentData:data,parentDataProperty:"nativeIdentity",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate142.errors : vErrors.concat(validate142.errors);
errors = vErrors.length;
}
var _valid0 = _errs6 === errors;
valid1 = valid1 || _valid0;
const _errs7 = errors;
if(data1 !== null){
const err0 = {instancePath:instancePath+"/nativeIdentity",schemaPath:"#/properties/nativeIdentity/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs7 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err1 = {instancePath:instancePath+"/nativeIdentity",schemaPath:"#/properties/nativeIdentity/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
validate141.errors = vErrors;
return false;
}
else {
errors = _errs5;
if(vErrors !== null){
if(_errs5){
vErrors.length = _errs5;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.source !== undefined){
const _errs9 = errors;
if(!(validate144(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate144.errors : vErrors.concat(validate144.errors);
errors = vErrors.length;
}
var valid0 = _errs9 === errors;
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
validate141.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate141.errors = vErrors;
return errors === 0;
}
validate141.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema169 = {"type":"object","properties":{"kind":{"$ref":"#/$defs/ContractRef"},"range":{"description":"Coordinates into the decoded unit text, not its original artifact.","$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["kind","range"]};
const schema171 = {"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema172 = {"type":"string","enum":["utf8-byte","utf16","grapheme"]};

function validate153(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate153.evaluated;
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
validate153.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate153.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate153.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme"))){
validate153.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/enum",keyword:"enum",params:{allowedValues: schema172.enum},message:"must be equal to one of the allowed values"}];
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
validate153.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate153.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate153.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate153.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate153.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate153.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate153.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate153.errors = vErrors;
return errors === 0;
}
validate153.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate152(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate152.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.range === undefined) && (missing0 = "range"))){
validate152.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "kind") || (key0 === "range"))){
validate152.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.kind !== undefined){
let data0 = data.kind;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate152.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate152.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate152.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate152.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate152.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate152.errors = [{instancePath:instancePath+"/kind/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate152.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate152.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate152.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate152.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.range !== undefined){
const _errs12 = errors;
if(!(validate153(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate153.errors : vErrors.concat(validate153.errors);
errors = vErrors.length;
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
else {
validate152.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate152.errors = vErrors;
return errors === 0;
}
validate152.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate140(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate140.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.id === undefined) && (missing0 = "id")) || ((data.sourceRevisionId === undefined) && (missing0 = "sourceRevisionId"))) || ((data.text === undefined) && (missing0 = "text"))) || ((data.occurrences === undefined) && (missing0 = "occurrences"))) || ((data.protectedFragments === undefined) && (missing0 = "protectedFragments"))){
validate140.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((key0 === "id") || (key0 === "occurrences")) || (key0 === "protectedFragments")) || (key0 === "sourceRevisionId")) || (key0 === "text"))){
validate140.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate140.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.occurrences !== undefined){
let data1 = data.occurrences;
const _errs4 = errors;
if(errors === _errs4){
if(Array.isArray(data1)){
var valid1 = true;
const len0 = data1.length;
for(let i0=0; i0<len0; i0++){
const _errs6 = errors;
if(!(validate141(data1[i0], {instancePath:instancePath+"/occurrences/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate141.errors : vErrors.concat(validate141.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate140.errors = [{instancePath:instancePath+"/occurrences",schemaPath:"#/properties/occurrences/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.protectedFragments !== undefined){
let data3 = data.protectedFragments;
const _errs7 = errors;
if(errors === _errs7){
if(Array.isArray(data3)){
var valid2 = true;
const len1 = data3.length;
for(let i1=0; i1<len1; i1++){
const _errs9 = errors;
if(!(validate152(data3[i1], {instancePath:instancePath+"/protectedFragments/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate152.errors : vErrors.concat(validate152.errors);
errors = vErrors.length;
}
var valid2 = _errs9 === errors;
if(!valid2){
break;
}
}
}
else {
validate140.errors = [{instancePath:instancePath+"/protectedFragments",schemaPath:"#/properties/protectedFragments/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceRevisionId !== undefined){
const _errs10 = errors;
if(typeof data.sourceRevisionId !== "string"){
validate140.errors = [{instancePath:instancePath+"/sourceRevisionId",schemaPath:"#/properties/sourceRevisionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.text !== undefined){
const _errs12 = errors;
if(typeof data.text !== "string"){
validate140.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
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
else {
validate140.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate140.errors = vErrors;
return errors === 0;
}
validate140.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate133(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate133.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((((data.profile === undefined) && (missing0 = "profile")) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.sourceLanguage === undefined) && (missing0 = "sourceLanguage"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))) || ((data.units === undefined) && (missing0 = "units"))) || ((data.order === undefined) && (missing0 = "order"))) || ((data.relations === undefined) && (missing0 = "relations"))) || ((data.domainBlocks === undefined) && (missing0 = "domainBlocks"))){
validate133.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "artifacts") || (key0 === "domainBlocks")) || (key0 === "order")) || (key0 === "profile")) || (key0 === "relations")) || (key0 === "sourceLanguage")) || (key0 === "sourceSetId")) || (key0 === "units"))){
validate133.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate134(data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate134.errors : vErrors.concat(validate134.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate133.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.domainBlocks !== undefined){
let data2 = data.domainBlocks;
const _errs5 = errors;
if(errors === _errs5){
if(Array.isArray(data2)){
var valid2 = true;
const len1 = data2.length;
for(let i1=0; i1<len1; i1++){
const _errs7 = errors;
if(!(validate136(data2[i1], {instancePath:instancePath+"/domainBlocks/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate136.errors : vErrors.concat(validate136.errors);
errors = vErrors.length;
}
var valid2 = _errs7 === errors;
if(!valid2){
break;
}
}
}
else {
validate133.errors = [{instancePath:instancePath+"/domainBlocks",schemaPath:"#/properties/domainBlocks/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.order !== undefined){
let data4 = data.order;
const _errs8 = errors;
if(errors === _errs8){
if(Array.isArray(data4)){
var valid3 = true;
const len2 = data4.length;
for(let i2=0; i2<len2; i2++){
const _errs10 = errors;
if(typeof data4[i2] !== "string"){
validate133.errors = [{instancePath:instancePath+"/order/" + i2,schemaPath:"#/properties/order/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs10 === errors;
if(!valid3){
break;
}
}
}
else {
validate133.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data6 = data.profile;
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(data6 && typeof data6 == "object" && !Array.isArray(data6)){
let missing1;
if((((data6.id === undefined) && (missing1 = "id")) || ((data6.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data6.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate133.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs15 = errors;
for(const key1 in data6){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate133.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs15 === errors){
if(data6.behaviorVersion !== undefined){
let data7 = data6.behaviorVersion;
const _errs16 = errors;
if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){
validate133.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs16){
if((typeof data7 == "number") && (isFinite(data7))){
if(data7 > 4294967295 || isNaN(data7)){
validate133.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data7 < 1 || isNaN(data7)){
validate133.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid5 = _errs16 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data6.id !== undefined){
const _errs18 = errors;
if(typeof data6.id !== "string"){
validate133.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid5 = _errs18 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data6.schemaVersion !== undefined){
let data9 = data6.schemaVersion;
const _errs20 = errors;
if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){
validate133.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs20){
if((typeof data9 == "number") && (isFinite(data9))){
if(data9 > 4294967295 || isNaN(data9)){
validate133.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data9 < 1 || isNaN(data9)){
validate133.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid5 = _errs20 === errors;
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
validate133.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.relations !== undefined){
let data10 = data.relations;
const _errs22 = errors;
if(errors === _errs22){
if(Array.isArray(data10)){
var valid6 = true;
const len3 = data10.length;
for(let i3=0; i3<len3; i3++){
const _errs24 = errors;
if(!(validate138(data10[i3], {instancePath:instancePath+"/relations/" + i3,parentData:data10,parentDataProperty:i3,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate138.errors : vErrors.concat(validate138.errors);
errors = vErrors.length;
}
var valid6 = _errs24 === errors;
if(!valid6){
break;
}
}
}
else {
validate133.errors = [{instancePath:instancePath+"/relations",schemaPath:"#/properties/relations/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs22 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceLanguage !== undefined){
const _errs25 = errors;
if(typeof data.sourceLanguage !== "string"){
validate133.errors = [{instancePath:instancePath+"/sourceLanguage",schemaPath:"#/properties/sourceLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs25 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs27 = errors;
if(typeof data.sourceSetId !== "string"){
validate133.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs27 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.units !== undefined){
let data14 = data.units;
const _errs29 = errors;
if(errors === _errs29){
if(Array.isArray(data14)){
var valid7 = true;
const len4 = data14.length;
for(let i4=0; i4<len4; i4++){
const _errs31 = errors;
if(!(validate140(data14[i4], {instancePath:instancePath+"/units/" + i4,parentData:data14,parentDataProperty:i4,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate140.errors : vErrors.concat(validate140.errors);
errors = vErrors.length;
}
var valid7 = _errs31 === errors;
if(!valid7){
break;
}
}
}
else {
validate133.errors = [{instancePath:instancePath+"/units",schemaPath:"#/properties/units/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs29 === errors;
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
validate133.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate133.errors = vErrors;
return errors === 0;
}
validate133.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate130(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate130.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((data.source === undefined) && (missing0 = "source")) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.targets === undefined) && (missing0 = "targets"))) || ((data.configuration === undefined) && (missing0 = "configuration"))) || ((data.outputPaths === undefined) && (missing0 = "outputPaths"))) || ((data.outputLimits === undefined) && (missing0 = "outputLimits"))){
validate130.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((key0 === "configuration") || (key0 === "outputLimits")) || (key0 === "outputPaths")) || (key0 === "source")) || (key0 === "targetLanguage")) || (key0 === "targets"))){
validate130.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.configuration !== undefined){
let data0 = data.configuration;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs4 = errors;
if(!(validate131(data0[i0], {instancePath:instancePath+"/configuration/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate131.errors : vErrors.concat(validate131.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate130.errors = [{instancePath:instancePath+"/configuration",schemaPath:"#/properties/configuration/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outputLimits !== undefined){
let data2 = data.outputLimits;
const _errs5 = errors;
const _errs6 = errors;
if(errors === _errs6){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing1;
if(((data2.maxArtifacts === undefined) && (missing1 = "maxArtifacts")) || ((data2.maxTotalBytes === undefined) && (missing1 = "maxTotalBytes"))){
validate130.errors = [{instancePath:instancePath+"/outputLimits",schemaPath:"#/$defs/BuildOutputLimits/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!((key1 === "maxArtifacts") || (key1 === "maxTotalBytes"))){
validate130.errors = [{instancePath:instancePath+"/outputLimits",schemaPath:"#/$defs/BuildOutputLimits/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.maxArtifacts !== undefined){
let data3 = data2.maxArtifacts;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate130.errors = [{instancePath:instancePath+"/outputLimits/maxArtifacts",schemaPath:"#/$defs/BuildOutputLimits/properties/maxArtifacts/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 32 || isNaN(data3)){
validate130.errors = [{instancePath:instancePath+"/outputLimits/maxArtifacts",schemaPath:"#/$defs/BuildOutputLimits/properties/maxArtifacts/maximum",keyword:"maximum",params:{comparison: "<=", limit: 32},message:"must be <= 32"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate130.errors = [{instancePath:instancePath+"/outputLimits/maxArtifacts",schemaPath:"#/$defs/BuildOutputLimits/properties/maxArtifacts/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid3 = _errs9 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data2.maxTotalBytes !== undefined){
let data4 = data2.maxTotalBytes;
const _errs11 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate130.errors = [{instancePath:instancePath+"/outputLimits/maxTotalBytes",schemaPath:"#/$defs/BuildOutputLimits/properties/maxTotalBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 268435456 || isNaN(data4)){
validate130.errors = [{instancePath:instancePath+"/outputLimits/maxTotalBytes",schemaPath:"#/$defs/BuildOutputLimits/properties/maxTotalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 268435456},message:"must be <= 268435456"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate130.errors = [{instancePath:instancePath+"/outputLimits/maxTotalBytes",schemaPath:"#/$defs/BuildOutputLimits/properties/maxTotalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid3 = _errs11 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
validate130.errors = [{instancePath:instancePath+"/outputLimits",schemaPath:"#/$defs/BuildOutputLimits/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outputPaths !== undefined){
let data5 = data.outputPaths;
const _errs13 = errors;
if(errors === _errs13){
if(Array.isArray(data5)){
var valid4 = true;
const len1 = data5.length;
for(let i1=0; i1<len1; i1++){
const _errs15 = errors;
if(typeof data5[i1] !== "string"){
validate130.errors = [{instancePath:instancePath+"/outputPaths/" + i1,schemaPath:"#/properties/outputPaths/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs15 === errors;
if(!valid4){
break;
}
}
}
else {
validate130.errors = [{instancePath:instancePath+"/outputPaths",schemaPath:"#/properties/outputPaths/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs13 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.source !== undefined){
const _errs17 = errors;
if(!(validate133(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate133.errors : vErrors.concat(validate133.errors);
errors = vErrors.length;
}
var valid0 = _errs17 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs18 = errors;
if(typeof data.targetLanguage !== "string"){
validate130.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs18 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targets !== undefined){
let data9 = data.targets;
const _errs20 = errors;
if(errors === _errs20){
if(Array.isArray(data9)){
var valid5 = true;
const len2 = data9.length;
for(let i2=0; i2<len2; i2++){
let data10 = data9[i2];
const _errs22 = errors;
const _errs23 = errors;
if(errors === _errs23){
if(data10 && typeof data10 == "object" && !Array.isArray(data10)){
let missing2;
if((((data10.unitId === undefined) && (missing2 = "unitId")) || ((data10.sourceRevisionId === undefined) && (missing2 = "sourceRevisionId"))) || ((data10.text === undefined) && (missing2 = "text"))){
validate130.errors = [{instancePath:instancePath+"/targets/" + i2,schemaPath:"#/$defs/BuildTarget/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs25 = errors;
for(const key2 in data10){
if(!(((key2 === "sourceRevisionId") || (key2 === "text")) || (key2 === "unitId"))){
validate130.errors = [{instancePath:instancePath+"/targets/" + i2,schemaPath:"#/$defs/BuildTarget/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs25 === errors){
if(data10.sourceRevisionId !== undefined){
const _errs26 = errors;
if(typeof data10.sourceRevisionId !== "string"){
validate130.errors = [{instancePath:instancePath+"/targets/" + i2+"/sourceRevisionId",schemaPath:"#/$defs/BuildTarget/properties/sourceRevisionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs26 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data10.text !== undefined){
const _errs28 = errors;
if(typeof data10.text !== "string"){
validate130.errors = [{instancePath:instancePath+"/targets/" + i2+"/text",schemaPath:"#/$defs/BuildTarget/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs28 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data10.unitId !== undefined){
const _errs30 = errors;
if(typeof data10.unitId !== "string"){
validate130.errors = [{instancePath:instancePath+"/targets/" + i2+"/unitId",schemaPath:"#/$defs/BuildTarget/properties/unitId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs30 === errors;
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
validate130.errors = [{instancePath:instancePath+"/targets/" + i2,schemaPath:"#/$defs/BuildTarget/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid5 = _errs22 === errors;
if(!valid5){
break;
}
}
}
else {
validate130.errors = [{instancePath:instancePath+"/targets",schemaPath:"#/properties/targets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
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
}
else {
validate130.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate130.errors = vErrors;
return errors === 0;
}
validate130.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema174 = {"description":"Actual text or binary output. Exact bytes do not establish domain conformance\nor release eligibility. Logical paths grant no filesystem authority.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","sourceSetId","targetLanguage","artifacts"]};

function validate159(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate159.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.profile === undefined) && (missing0 = "profile")) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))){
validate159.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "artifacts") || (key0 === "profile")) || (key0 === "sourceSetId")) || (key0 === "targetLanguage"))){
validate159.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate134(data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate134.errors : vErrors.concat(validate134.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate159.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data2 = data.profile;
const _errs5 = errors;
const _errs6 = errors;
if(errors === _errs6){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing1;
if((((data2.id === undefined) && (missing1 = "id")) || ((data2.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data2.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate159.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate159.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate159.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate159.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate159.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid3 = _errs9 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data2.id !== undefined){
const _errs11 = errors;
if(typeof data2.id !== "string"){
validate159.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs11 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data2.schemaVersion !== undefined){
let data5 = data2.schemaVersion;
const _errs13 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
validate159.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs13){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate159.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate159.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid3 = _errs13 === errors;
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
validate159.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs15 = errors;
if(typeof data.sourceSetId !== "string"){
validate159.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs17 = errors;
if(typeof data.targetLanguage !== "string"){
validate159.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs17 === errors;
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
validate159.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate159.errors = vErrors;
return errors === 0;
}
validate159.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema176 = {"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]};
const schema183 = {"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]};
const schema177 = {"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]};
const schema178 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]};
const schema180 = {"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]};
const schema181 = {"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]};

function validate165(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate165.evaluated;
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
validate165.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "componentId") || (key0 === "contributionId")) || (key0 === "packageDigest")) || (key0 === "plugin"))){
validate165.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.componentId !== undefined){
const _errs2 = errors;
if(typeof data.componentId !== "string"){
validate165.errors = [{instancePath:instancePath+"/componentId",schemaPath:"#/properties/componentId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate165.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate165.errors = [{instancePath:instancePath+"/packageDigest",schemaPath:"#/properties/packageDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate165.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs11 = errors;
for(const key1 in data3){
if(!(((key1 === "id") || (key1 === "publisher")) || (key1 === "version"))){
validate165.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs11 === errors){
if(data3.id !== undefined){
const _errs12 = errors;
if(typeof data3.id !== "string"){
validate165.errors = [{instancePath:instancePath+"/plugin/id",schemaPath:"#/$defs/PluginIdentity/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate165.errors = [{instancePath:instancePath+"/plugin/publisher",schemaPath:"#/$defs/PluginIdentity/properties/publisher/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate165.errors = [{instancePath:instancePath+"/plugin/version",schemaPath:"#/$defs/PluginIdentity/properties/version/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate165.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate165.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate165.errors = vErrors;
return errors === 0;
}
validate165.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate164(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate164.evaluated;
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
if(!(validate165(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate165.errors : vErrors.concat(validate165.errors);
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
validate164.errors = vErrors;
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
validate164.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate164.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate163(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate163.evaluated;
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
validate163.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "implementation") || (key0 === "rule"))){
validate163.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.implementation !== undefined){
const _errs2 = errors;
if(!(validate164(data.implementation, {instancePath:instancePath+"/implementation",parentData:data,parentDataProperty:"implementation",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate164.errors : vErrors.concat(validate164.errors);
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
validate163.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs6 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate163.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs6 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate163.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate163.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate163.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate163.errors = [{instancePath:instancePath+"/rule/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate163.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate163.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate163.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate163.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate163.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate163.errors = vErrors;
return errors === 0;
}
validate163.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate162(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate162.evaluated;
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
validate162.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((((key0 === "inputDigest") || (key0 === "key")) || (key0 === "mandatory")) || (key0 === "notApplicable")) || (key0 === "scopeDigest")) || (key0 === "targets")) || (key0 === "waivable"))){
validate162.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.inputDigest !== undefined){
const _errs2 = errors;
if(typeof data.inputDigest !== "string"){
validate162.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate163(data.key, {instancePath:instancePath+"/key",parentData:data,parentDataProperty:"key",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate163.errors : vErrors.concat(validate163.errors);
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
validate162.errors = [{instancePath:instancePath+"/mandatory",schemaPath:"#/properties/mandatory/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
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
validate162.errors = vErrors;
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
validate162.errors = [{instancePath:instancePath+"/scopeDigest",schemaPath:"#/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate162.errors = [{instancePath:instancePath+"/targets/" + i0,schemaPath:"#/properties/targets/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs23 === errors;
if(!valid4){
break;
}
}
}
else {
validate162.errors = [{instancePath:instancePath+"/targets",schemaPath:"#/properties/targets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate162.errors = [{instancePath:instancePath+"/waivable",schemaPath:"#/properties/waivable/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
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
validate162.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate162.errors = vErrors;
return errors === 0;
}
validate162.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate129(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate129.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.input === undefined) && (missing0 = "input")) || ((data.output === undefined) && (missing0 = "output"))) || ((data.requirements === undefined) && (missing0 = "requirements"))){
validate129.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "input") || (key0 === "output")) || (key0 === "requirements"))){
validate129.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.input !== undefined){
const _errs2 = errors;
if(!(validate130(data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate130.errors : vErrors.concat(validate130.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.output !== undefined){
const _errs3 = errors;
if(!(validate159(data.output, {instancePath:instancePath+"/output",parentData:data,parentDataProperty:"output",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate159.errors : vErrors.concat(validate159.errors);
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
if(!(validate162(data2[i0], {instancePath:instancePath+"/requirements/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate162.errors : vErrors.concat(validate162.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate129.errors = [{instancePath:instancePath+"/requirements",schemaPath:"#/properties/requirements/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate129.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate129.errors = vErrors;
return errors === 0;
}
validate129.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
