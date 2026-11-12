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
export const validate = validate98;
export default validate98;
const schema112 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"BuildInput","type":"object","properties":{"configuration":{"description":"Exact domain configuration; an empty collection means no configuration.","type":"array","items":{"$ref":"#/$defs/EncodedPayload"}},"outputLimits":{"description":"Captured by the trusted planner, never replaced by returned artifacts.","$ref":"#/$defs/BuildOutputLimits"},"outputPaths":{"description":"Complete authorized relative output paths, fixed before dispatch.","type":"array","items":{"type":"string"}},"source":{"$ref":"#/$defs/ContentExchange"},"targetLanguage":{"type":"string"},"targets":{"type":"array","items":{"$ref":"#/$defs/BuildTarget"}}},"additionalProperties":false,"required":["source","targetLanguage","targets","configuration","outputPaths","outputLimits"],"$defs":{"BuildOutputLimits":{"type":"object","properties":{"maxArtifacts":{"type":"integer","maximum":32,"minimum":1},"maxTotalBytes":{"type":"integer","maximum":268435456,"minimum":1}},"additionalProperties":false,"required":["maxArtifacts","maxTotalBytes"]},"BuildTarget":{"description":"One already decided text per source unit, even when it has many occurrences.\nNo candidate selection, review decision or project write handle is supplied.","type":"object","properties":{"sourceRevisionId":{"type":"string"},"text":{"type":"string"},"unitId":{"type":"string"}},"additionalProperties":false,"required":["unitId","sourceRevisionId","text"]},"CapturedArtifact":{"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]},"CapturedBinaryArtifact":{"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]},"CapturedTextArtifact":{"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]},"ContentExchange":{"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"domainBlocks":{"type":"array","items":{"$ref":"#/$defs/DomainBlock"}},"order":{"description":"Exact occurrence order. Hierarchies and other graphs use typed relations.","type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"relations":{"type":"array","items":{"$ref":"#/$defs/ContentRelation"}},"sourceLanguage":{"type":"string"},"sourceSetId":{"type":"string"},"units":{"type":"array","items":{"$ref":"#/$defs/ContentUnit"}}},"additionalProperties":false,"required":["profile","sourceSetId","sourceLanguage","artifacts","units","order","relations","domainBlocks"]},"ContentOccurrence":{"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"anyOf":[{"$ref":"#/$defs/NativeIdentityEvidence"},{"type":"null"}]},"source":{"$ref":"#/$defs/SourceReference"}},"additionalProperties":false,"required":["id","source"]},"ContentRelation":{"type":"object","properties":{"fromOccurrence":{"type":"string"},"kind":{"$ref":"#/$defs/ContractRef"},"toOccurrence":{"type":"string"}},"additionalProperties":false,"required":["kind","fromOccurrence","toOccurrence"]},"ContentTarget":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"snapshot"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"unit"}},"additionalProperties":false,"required":["kind","id"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"occurrence"}},"additionalProperties":false,"required":["kind","id"]}]},"ContentUnit":{"type":"object","properties":{"id":{"description":"Operation-local reference or a captured project identity, as specified by\nthe capability. A plugin cannot allocate authoritative project revisions.","type":"string"},"occurrences":{"type":"array","items":{"$ref":"#/$defs/ContentOccurrence"}},"protectedFragments":{"type":"array","items":{"$ref":"#/$defs/ProtectedFragment"}},"sourceRevisionId":{"description":"During extraction this is an operation-local proposal reference. Only\nCore may map it to an authoritative project source revision.","type":"string"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","sourceRevisionId","text","occurrences","protectedFragments"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"DomainBlock":{"type":"object","properties":{"handling":{"$ref":"#/$defs/ExtensionHandling"},"payloadUtf8":{"description":"Exact UTF-8 payload, intentionally not an open JSON property bag. Its\nschema is interpreted by the domain, without loss through Value parsing.","type":"string"},"schema":{"$ref":"#/$defs/ContractRef"},"target":{"$ref":"#/$defs/ContentTarget"}},"additionalProperties":false,"required":["target","schema","handling","payloadUtf8"]},"EncodedPayload":{"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]},"ExtensionHandling":{"oneOf":[{"description":"An operation that needs this block must have the exact interpreter.","type":"string","const":"required"},{"description":"Preserve the payload exactly, including when its schema is understood.","type":"string","const":"preserve"},{"description":"Interpretation is optional; an unknown payload is still preserved.","type":"string","const":"optional"}]},"NativeIdentityDisplay":{"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]},"NativeIdentityEvidence":{"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]},"ProtectedFragment":{"type":"object","properties":{"kind":{"$ref":"#/$defs/ContractRef"},"range":{"description":"Coordinates into the decoded unit text, not its original artifact.","$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["kind","range"]},"SourceEncoding":{"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]},"SourceRange":{"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]},"TextEncoding":{"type":"string","enum":["utf8-byte","utf16","grapheme"]},"TextRange":{"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]}}};
const schema115 = {"type":"object","properties":{"maxArtifacts":{"type":"integer","maximum":32,"minimum":1},"maxTotalBytes":{"type":"integer","maximum":268435456,"minimum":1}},"additionalProperties":false,"required":["maxArtifacts","maxTotalBytes"]};
const schema139 = {"description":"One already decided text per source unit, even when it has many occurrences.\nNo candidate selection, review decision or project write handle is supplied.","type":"object","properties":{"sourceRevisionId":{"type":"string"},"text":{"type":"string"},"unitId":{"type":"string"}},"additionalProperties":false,"required":["unitId","sourceRevisionId","text"]};
const schema113 = {"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]};
const schema114 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};

function validate99(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate99.evaluated;
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
validate99.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "schema") || (key0 === "sha256")) || (key0 === "utf8"))){
validate99.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
validate99.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate99.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate99.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate99.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate99.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate99.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate99.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate99.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate99.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate99.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate99.errors = [{instancePath:instancePath+"/sha256",schemaPath:"#/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate99.errors = [{instancePath:instancePath+"/utf8",schemaPath:"#/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate99.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate99.errors = vErrors;
return errors === 0;
}
validate99.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema116 = {"type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"domainBlocks":{"type":"array","items":{"$ref":"#/$defs/DomainBlock"}},"order":{"description":"Exact occurrence order. Hierarchies and other graphs use typed relations.","type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"relations":{"type":"array","items":{"$ref":"#/$defs/ContentRelation"}},"sourceLanguage":{"type":"string"},"sourceSetId":{"type":"string"},"units":{"type":"array","items":{"$ref":"#/$defs/ContentUnit"}}},"additionalProperties":false,"required":["profile","sourceSetId","sourceLanguage","artifacts","units","order","relations","domainBlocks"]};
const schema117 = {"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]};
const schema118 = {"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]};
const schema119 = {"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]};

function validate102(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate102.evaluated;
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
validate102.errors = vErrors;
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
validate102.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate102.evaluated = {"dynamicProps":true,"dynamicItems":false};

const schema120 = {"type":"object","properties":{"handling":{"$ref":"#/$defs/ExtensionHandling"},"payloadUtf8":{"description":"Exact UTF-8 payload, intentionally not an open JSON property bag. Its\nschema is interpreted by the domain, without loss through Value parsing.","type":"string"},"schema":{"$ref":"#/$defs/ContractRef"},"target":{"$ref":"#/$defs/ContentTarget"}},"additionalProperties":false,"required":["target","schema","handling","payloadUtf8"]};
const schema121 = {"oneOf":[{"description":"An operation that needs this block must have the exact interpreter.","type":"string","const":"required"},{"description":"Preserve the payload exactly, including when its schema is understood.","type":"string","const":"preserve"},{"description":"Interpretation is optional; an unknown payload is still preserved.","type":"string","const":"optional"}]};
const schema123 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"snapshot"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"unit"}},"additionalProperties":false,"required":["kind","id"]},{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","const":"occurrence"}},"additionalProperties":false,"required":["kind","id"]}]};

function validate104(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate104.evaluated;
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
validate104.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "handling") || (key0 === "payloadUtf8")) || (key0 === "schema")) || (key0 === "target"))){
validate104.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
validate104.errors = vErrors;
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
validate104.errors = [{instancePath:instancePath+"/payloadUtf8",schemaPath:"#/properties/payloadUtf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate104.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs16 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate104.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs16 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs17 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate104.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs17){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate104.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate104.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate104.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate104.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs21){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate104.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate104.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate104.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate104.errors = vErrors;
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
validate104.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate104.errors = vErrors;
return errors === 0;
}
validate104.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema125 = {"type":"object","properties":{"fromOccurrence":{"type":"string"},"kind":{"$ref":"#/$defs/ContractRef"},"toOccurrence":{"type":"string"}},"additionalProperties":false,"required":["kind","fromOccurrence","toOccurrence"]};

function validate106(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate106.evaluated;
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
validate106.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "fromOccurrence") || (key0 === "kind")) || (key0 === "toOccurrence"))){
validate106.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.fromOccurrence !== undefined){
const _errs2 = errors;
if(typeof data.fromOccurrence !== "string"){
validate106.errors = [{instancePath:instancePath+"/fromOccurrence",schemaPath:"#/properties/fromOccurrence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate106.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate106.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate106.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate106.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate106.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate106.errors = [{instancePath:instancePath+"/kind/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate106.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate106.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate106.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate106.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate106.errors = [{instancePath:instancePath+"/toOccurrence",schemaPath:"#/properties/toOccurrence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate106.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate106.errors = vErrors;
return errors === 0;
}
validate106.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema127 = {"type":"object","properties":{"id":{"description":"Operation-local reference or a captured project identity, as specified by\nthe capability. A plugin cannot allocate authoritative project revisions.","type":"string"},"occurrences":{"type":"array","items":{"$ref":"#/$defs/ContentOccurrence"}},"protectedFragments":{"type":"array","items":{"$ref":"#/$defs/ProtectedFragment"}},"sourceRevisionId":{"description":"During extraction this is an operation-local proposal reference. Only\nCore may map it to an authoritative project source revision.","type":"string"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","sourceRevisionId","text","occurrences","protectedFragments"]};
const schema128 = {"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"anyOf":[{"$ref":"#/$defs/NativeIdentityEvidence"},{"type":"null"}]},"source":{"$ref":"#/$defs/SourceReference"}},"additionalProperties":false,"required":["id","source"]};
const schema129 = {"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]};
const schema130 = {"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]};
const schema131 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/SourceRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema132 = {"type":"object","properties":{"encoding":{"$ref":"#/$defs/SourceEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema133 = {"description":"Source coordinates are separate from ranges in decoded unit/target text.","type":"string","enum":["utf8-byte","utf16","grapheme","raw-byte"]};

function validate113(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate113.evaluated;
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
validate113.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate113.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate113.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme")) || (data0 === "raw-byte"))){
validate113.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/SourceEncoding/enum",keyword:"enum",params:{allowedValues: schema133.enum},message:"must be equal to one of the allowed values"}];
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
validate113.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate113.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate113.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate113.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate113.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate113.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate113.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate113.errors = vErrors;
return errors === 0;
}
validate113.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate112(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate112.evaluated;
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
validate112.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate112.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate112.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate113(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate113.errors : vErrors.concat(validate113.errors);
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
validate112.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate112.errors = vErrors;
return errors === 0;
}
validate112.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate111(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate111.evaluated;
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
validate111.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "source") || (key0 === "value"))){
validate111.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate112(data0, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate112.errors : vErrors.concat(validate112.errors);
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
validate111.errors = vErrors;
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
validate111.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate111.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate111.errors = vErrors;
return errors === 0;
}
validate111.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate110(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate110.evaluated;
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
validate110.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "display") || (key0 === "namespace")) || (key0 === "policy")) || (key0 === "value"))){
validate110.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.display !== undefined){
const _errs2 = errors;
if(!(validate111(data.display, {instancePath:instancePath+"/display",parentData:data,parentDataProperty:"display",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate111.errors : vErrors.concat(validate111.errors);
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
validate110.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate110.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate110.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate110.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate110.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate110.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate110.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate110.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs13){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate110.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate110.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate110.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate110.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate110.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate110.errors = vErrors;
return errors === 0;
}
validate110.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate109(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate109.evaluated;
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
validate109.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "id") || (key0 === "nativeIdentity")) || (key0 === "source"))){
validate109.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate109.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate110(data1, {instancePath:instancePath+"/nativeIdentity",parentData:data,parentDataProperty:"nativeIdentity",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate110.errors : vErrors.concat(validate110.errors);
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
validate109.errors = vErrors;
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
if(!(validate112(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate112.errors : vErrors.concat(validate112.errors);
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
validate109.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate109.errors = vErrors;
return errors === 0;
}
validate109.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema135 = {"type":"object","properties":{"kind":{"$ref":"#/$defs/ContractRef"},"range":{"description":"Coordinates into the decoded unit text, not its original artifact.","$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["kind","range"]};
const schema137 = {"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema138 = {"type":"string","enum":["utf8-byte","utf16","grapheme"]};

function validate121(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate121.evaluated;
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
validate121.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate121.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate121.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme"))){
validate121.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/enum",keyword:"enum",params:{allowedValues: schema138.enum},message:"must be equal to one of the allowed values"}];
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
validate121.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate121.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate121.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate121.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate121.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate121.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
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
validate121.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate121.errors = vErrors;
return errors === 0;
}
validate121.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate120(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate120.evaluated;
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
validate120.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "kind") || (key0 === "range"))){
validate120.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
validate120.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate120.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate120.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate120.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate120.errors = [{instancePath:instancePath+"/kind/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate120.errors = [{instancePath:instancePath+"/kind/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate120.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate120.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate120.errors = [{instancePath:instancePath+"/kind/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate120.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
if(!(validate121(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate121.errors : vErrors.concat(validate121.errors);
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
validate120.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate120.errors = vErrors;
return errors === 0;
}
validate120.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate108(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate108.evaluated;
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
validate108.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((key0 === "id") || (key0 === "occurrences")) || (key0 === "protectedFragments")) || (key0 === "sourceRevisionId")) || (key0 === "text"))){
validate108.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate108.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate109(data1[i0], {instancePath:instancePath+"/occurrences/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate109.errors : vErrors.concat(validate109.errors);
errors = vErrors.length;
}
var valid1 = _errs6 === errors;
if(!valid1){
break;
}
}
}
else {
validate108.errors = [{instancePath:instancePath+"/occurrences",schemaPath:"#/properties/occurrences/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
if(!(validate120(data3[i1], {instancePath:instancePath+"/protectedFragments/" + i1,parentData:data3,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate120.errors : vErrors.concat(validate120.errors);
errors = vErrors.length;
}
var valid2 = _errs9 === errors;
if(!valid2){
break;
}
}
}
else {
validate108.errors = [{instancePath:instancePath+"/protectedFragments",schemaPath:"#/properties/protectedFragments/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate108.errors = [{instancePath:instancePath+"/sourceRevisionId",schemaPath:"#/properties/sourceRevisionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate108.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate108.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate108.errors = vErrors;
return errors === 0;
}
validate108.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate101(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate101.evaluated;
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
validate101.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "artifacts") || (key0 === "domainBlocks")) || (key0 === "order")) || (key0 === "profile")) || (key0 === "relations")) || (key0 === "sourceLanguage")) || (key0 === "sourceSetId")) || (key0 === "units"))){
validate101.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate102(data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate102.errors : vErrors.concat(validate102.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate101.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
if(!(validate104(data2[i1], {instancePath:instancePath+"/domainBlocks/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate104.errors : vErrors.concat(validate104.errors);
errors = vErrors.length;
}
var valid2 = _errs7 === errors;
if(!valid2){
break;
}
}
}
else {
validate101.errors = [{instancePath:instancePath+"/domainBlocks",schemaPath:"#/properties/domainBlocks/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate101.errors = [{instancePath:instancePath+"/order/" + i2,schemaPath:"#/properties/order/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs10 === errors;
if(!valid3){
break;
}
}
}
else {
validate101.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate101.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs15 = errors;
for(const key1 in data6){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate101.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs15 === errors){
if(data6.behaviorVersion !== undefined){
let data7 = data6.behaviorVersion;
const _errs16 = errors;
if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){
validate101.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs16){
if((typeof data7 == "number") && (isFinite(data7))){
if(data7 > 4294967295 || isNaN(data7)){
validate101.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data7 < 1 || isNaN(data7)){
validate101.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate101.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate101.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs20){
if((typeof data9 == "number") && (isFinite(data9))){
if(data9 > 4294967295 || isNaN(data9)){
validate101.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data9 < 1 || isNaN(data9)){
validate101.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate101.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
if(!(validate106(data10[i3], {instancePath:instancePath+"/relations/" + i3,parentData:data10,parentDataProperty:i3,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate106.errors : vErrors.concat(validate106.errors);
errors = vErrors.length;
}
var valid6 = _errs24 === errors;
if(!valid6){
break;
}
}
}
else {
validate101.errors = [{instancePath:instancePath+"/relations",schemaPath:"#/properties/relations/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate101.errors = [{instancePath:instancePath+"/sourceLanguage",schemaPath:"#/properties/sourceLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate101.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
if(!(validate108(data14[i4], {instancePath:instancePath+"/units/" + i4,parentData:data14,parentDataProperty:i4,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate108.errors : vErrors.concat(validate108.errors);
errors = vErrors.length;
}
var valid7 = _errs31 === errors;
if(!valid7){
break;
}
}
}
else {
validate101.errors = [{instancePath:instancePath+"/units",schemaPath:"#/properties/units/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate101.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate101.errors = vErrors;
return errors === 0;
}
validate101.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate98(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate98.evaluated;
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
validate98.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((key0 === "configuration") || (key0 === "outputLimits")) || (key0 === "outputPaths")) || (key0 === "source")) || (key0 === "targetLanguage")) || (key0 === "targets"))){
validate98.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
if(!(validate99(data0[i0], {instancePath:instancePath+"/configuration/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate99.errors : vErrors.concat(validate99.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate98.errors = [{instancePath:instancePath+"/configuration",schemaPath:"#/properties/configuration/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate98.errors = [{instancePath:instancePath+"/outputLimits",schemaPath:"#/$defs/BuildOutputLimits/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!((key1 === "maxArtifacts") || (key1 === "maxTotalBytes"))){
validate98.errors = [{instancePath:instancePath+"/outputLimits",schemaPath:"#/$defs/BuildOutputLimits/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.maxArtifacts !== undefined){
let data3 = data2.maxArtifacts;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate98.errors = [{instancePath:instancePath+"/outputLimits/maxArtifacts",schemaPath:"#/$defs/BuildOutputLimits/properties/maxArtifacts/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 32 || isNaN(data3)){
validate98.errors = [{instancePath:instancePath+"/outputLimits/maxArtifacts",schemaPath:"#/$defs/BuildOutputLimits/properties/maxArtifacts/maximum",keyword:"maximum",params:{comparison: "<=", limit: 32},message:"must be <= 32"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate98.errors = [{instancePath:instancePath+"/outputLimits/maxArtifacts",schemaPath:"#/$defs/BuildOutputLimits/properties/maxArtifacts/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate98.errors = [{instancePath:instancePath+"/outputLimits/maxTotalBytes",schemaPath:"#/$defs/BuildOutputLimits/properties/maxTotalBytes/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 268435456 || isNaN(data4)){
validate98.errors = [{instancePath:instancePath+"/outputLimits/maxTotalBytes",schemaPath:"#/$defs/BuildOutputLimits/properties/maxTotalBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 268435456},message:"must be <= 268435456"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate98.errors = [{instancePath:instancePath+"/outputLimits/maxTotalBytes",schemaPath:"#/$defs/BuildOutputLimits/properties/maxTotalBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate98.errors = [{instancePath:instancePath+"/outputLimits",schemaPath:"#/$defs/BuildOutputLimits/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate98.errors = [{instancePath:instancePath+"/outputPaths/" + i1,schemaPath:"#/properties/outputPaths/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs15 === errors;
if(!valid4){
break;
}
}
}
else {
validate98.errors = [{instancePath:instancePath+"/outputPaths",schemaPath:"#/properties/outputPaths/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
if(!(validate101(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate101.errors : vErrors.concat(validate101.errors);
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
validate98.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate98.errors = [{instancePath:instancePath+"/targets/" + i2,schemaPath:"#/$defs/BuildTarget/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs25 = errors;
for(const key2 in data10){
if(!(((key2 === "sourceRevisionId") || (key2 === "text")) || (key2 === "unitId"))){
validate98.errors = [{instancePath:instancePath+"/targets/" + i2,schemaPath:"#/$defs/BuildTarget/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs25 === errors){
if(data10.sourceRevisionId !== undefined){
const _errs26 = errors;
if(typeof data10.sourceRevisionId !== "string"){
validate98.errors = [{instancePath:instancePath+"/targets/" + i2+"/sourceRevisionId",schemaPath:"#/$defs/BuildTarget/properties/sourceRevisionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate98.errors = [{instancePath:instancePath+"/targets/" + i2+"/text",schemaPath:"#/$defs/BuildTarget/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate98.errors = [{instancePath:instancePath+"/targets/" + i2+"/unitId",schemaPath:"#/$defs/BuildTarget/properties/unitId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate98.errors = [{instancePath:instancePath+"/targets/" + i2,schemaPath:"#/$defs/BuildTarget/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate98.errors = [{instancePath:instancePath+"/targets",schemaPath:"#/properties/targets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
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
validate98.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate98.errors = vErrors;
return errors === 0;
}
validate98.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
